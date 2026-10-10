// services/memberAttendanceService.js
//
// The ONE place that opens and closes a member's attendance sessions. Used by
// the RFID tap (attendanceService.processMemberScan) and by the admin manual
// endpoint (adminController.createManualAttendance), so both follow the same
// rules:
//
//   * A member can have many sessions per day (Time-In .. Time-Out each).
//   * A member can have at most ONE open session at a time. This is enforced
//     by the database: new sessions are written with openSession: true and a
//     partial unique index on { userId } where openSession is true makes a
//     second concurrent open session fail with E11000 - no matter how many
//     requests arrive at once or from which entry point.
//   * Time-Out closes the open session with one conditional update
//     (checkOut still missing), so two simultaneous Time-Outs close it once.
//   * An optional requestId (idempotency key) makes a retried request return
//     the original result instead of repeating the action.
//   * A subscription "session" is a gym DAY (the dashboard derives the total
//     from the plan's day span), so only the FIRST Time-In of a Manila day
//     deducts one. Further Time-Ins the same day deduct nothing.
//   * Timestamps are the server's clock (`now`), never the client's.
//   * Every action for one member runs through a per-member FIFO lock, so
//     taps/requests for the same member are applied in the order they were
//     received (in-process coordination; the DB index above is the guarantee).
const Attendance = require('../models/Attendance');
const subscriptionService = require('./subscriptionService');
const { startOfLocalDay, formatLocalDateLabel } = require('../utils/localDate');
const { withKeyLock } = require('../utils/keyedMutex');

const fail = (message, statusCode, errorType) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.errorType = errorType;
  return err;
};

const sameId = (a, b) => String(a && a._id ? a._id : a) === String(b && b._id ? b._id : b);

// Idempotency keys come from the client: keep them short and boring.
const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,100}$/;
function cleanRequestId(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !REQUEST_ID.test(raw.trim())) {
    throw fail('requestId must be 8-100 characters (letters, digits, - _ . :)', 400, 'invalid_request_id');
  }
  return raw.trim();
}

// Today's open session for this member (Manila day), straight from the DB.
function findOpenSession(userId, now = new Date()) {
  return Attendance.findOne({
    userId,
    subjectType: 'member',
    createdAt: { $gte: startOfLocalDay(now) },
    checkOut: { $exists: false },
  });
}

// A session left open on a PREVIOUS day (the member never tapped out) must not
// lock them out of today. Its Time-Out stays empty - we never invent a
// timestamp - and it is flagged so reports can show "no time-out recorded".
async function retireStaleOpenSessions(userId, now = new Date()) {
  await Attendance.updateMany(
    { userId, openSession: true, createdAt: { $lt: startOfLocalDay(now) } },
    { $set: { missedCheckOut: true }, $unset: { openSession: 1 } },
  );
}

// Time-In: always a NEW row; never touches an earlier session.
async function doCheckIn({ user, now = new Date(), rfidCardId, memberType, notes, requestId } = {}) {
  const rid = cleanRequestId(requestId);
  const userId = user._id;

  if (rid) {
    const prior = await Attendance.findOne({ requestId: rid });
    if (prior) {
      if (!sameId(prior.userId, userId)) throw fail('That request id belongs to a different request', 409, 'request_id_conflict');
      return { attendance: prior, action: 'checkin', replayed: true, deducted: false };
    }
  }

  await retireStaleOpenSessions(userId, now);
  if (await findOpenSession(userId, now)) {
    throw fail('Member is already checked in. Time out first.', 409, 'already_checked_in');
  }

  let attendance;
  try {
    attendance = await Attendance.create({
      userId,
      subjectType: 'member',
      attendanceType: 'MEMBER',
      dayKey: formatLocalDateLabel(now),
      openSession: true,
      ...(rfidCardId ? { rfidCardId } : {}),
      memberType: memberType === 'Student' ? 'Student' : 'Regular',
      checkIn: now,
      ...(notes ? { notes } : {}),
      ...(rid ? { requestId: rid } : {}),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Either the same request arrived twice at once, or another request
      // opened a session an instant earlier. Neither may create a second row.
      if (rid) {
        const prior = await Attendance.findOne({ requestId: rid });
        if (prior && sameId(prior.userId, userId)) return { attendance: prior, action: 'checkin', replayed: true, deducted: false };
      }
      throw fail('Member is already checked in. Time out first.', 409, 'already_checked_in');
    }
    throw err;
  }

  // First Time-In of the Manila day deducts one subscription session; later
  // Time-Ins the same day do not. Counting AFTER the insert is race-safe: a
  // second session can only exist after the first row does.
  let deducted = false;
  let warning;
  const sessionsToday = await Attendance.countDocuments({
    userId, subjectType: 'member', createdAt: { $gte: startOfLocalDay(now) },
  });
  if (sessionsToday === 1) {
    try {
      await subscriptionService.recordAttendanceSession(userId);
      deducted = true;
    } catch (err) {
      // The attendance row IS saved; do not report a failed save. Surface it
      // for staff and keep the evidence in the server log.
      console.error('[ATTENDANCE] session deduction failed after check-in', { userId: String(userId), attendanceId: String(attendance._id), error: err.message });
      warning = 'Attendance saved, but the subscription session could not be updated. Please tell the admin.';
    }
  }
  return { attendance, action: 'checkin', replayed: false, deducted, warning };
}

// Time-Out: closes exactly the member's open session.
async function doCheckOut({ user, now = new Date(), requestId } = {}) {
  const rid = cleanRequestId(requestId);
  const userId = user._id;

  if (rid) {
    const prior = await Attendance.findOne({ checkOutRequestId: rid });
    if (prior) {
      if (!sameId(prior.userId, userId)) throw fail('That request id belongs to a different request', 409, 'request_id_conflict');
      return { attendance: prior, action: 'checkout', replayed: true };
    }
  }

  const open = await findOpenSession(userId, now);
  if (!open) throw fail('Member is not checked in. Time in first.', 409, 'not_checked_in');

  let closed;
  try {
    closed = await Attendance.findOneAndUpdate(
      { _id: open._id, checkOut: { $exists: false } },
      { $set: { checkOut: now, ...(rid ? { checkOutRequestId: rid } : {}) }, $unset: { openSession: 1 } },
      { new: true },
    );
  } catch (err) {
    if (err && err.code === 11000 && rid) {
      const prior = await Attendance.findOne({ checkOutRequestId: rid });
      if (prior && sameId(prior.userId, userId)) return { attendance: prior, action: 'checkout', replayed: true };
    }
    throw err;
  }
  if (!closed) throw fail('Member has already been checked out', 409, 'not_checked_in');
  return { attendance: closed, action: 'checkout', replayed: false };
}

// Looks a request id up in BOTH idempotency fields: a Time-In stores it as
// requestId, a Time-Out as checkOutRequestId. Returns the original outcome or
// null. `userId` (optional) guards against one id being reused for another
// member.
async function findReplay(rid, userId) {
  if (!rid) return null;
  let prior = await Attendance.findOne({ requestId: rid });
  let action = 'checkin';
  if (!prior) {
    prior = await Attendance.findOne({ checkOutRequestId: rid });
    action = 'checkout';
  }
  if (!prior) return null;
  if (userId && !sameId(prior.userId, userId)) throw fail('That request id belongs to a different request', 409, 'request_id_conflict');
  return { attendance: prior, action, replayed: true, ...(action === 'checkin' ? { deducted: false } : {}) };
}

// RFID tap: no explicit intent, so it toggles - open session => Time-Out,
// otherwise Time-In. The open/closed state is read from the DB inside the
// member's lock, so consecutive taps alternate IN, OUT, IN, OUT... in the
// order they arrive. A tap that still loses a race (another process, the admin
// screen) is a duplicate, not a new action. With a requestId (the bridge's
// per-tap scanId) a retried tap returns the original result instead of
// toggling again.
async function toggle({ user, now = new Date(), rfidCardId, memberType, requestId } = {}) {
  const rid = cleanRequestId(requestId);
  return withKeyLock(`member:${user._id}`, async () => {
    if (rid) {
      const replay = await findReplay(rid, user._id);
      if (replay) return replay;
    }
    const open = await findOpenSession(user._id, now);
    try {
      return open
        ? await doCheckOut({ user, now, requestId: rid })
        : await doCheckIn({ user, now, rfidCardId, memberType, requestId: rid });
    } catch (err) {
      if (err.errorType === 'already_checked_in' || err.errorType === 'not_checked_in') {
        throw fail('Duplicate scan prevented', 429, 'duplicate_scan');
      }
      throw err;
    }
  });
}

// Public single-action entry points (admin manual attendance): same lock.
const checkIn = (args = {}) => withKeyLock(`member:${args.user && args.user._id}`, () => doCheckIn(args));
const checkOut = (args = {}) => withKeyLock(`member:${args.user && args.user._id}`, () => doCheckOut(args));

module.exports = { checkIn, checkOut, toggle, findOpenSession, findReplay, retireStaleOpenSessions, cleanRequestId, fail };
