// services/attendanceService.js
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');
const subscriptionService = require('./subscriptionService');
const { getScanMessage } = require('../utils/scanMessages');
const { startOfLocalDay } = require('../utils/localDate');

const httpError = (message, statusCode, errorType) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.errorType = errorType; // lets callers distinguish cases if needed
  return err;
};

// Emits the standard rfid:error admin event for a given errorType, pulling
// title/body wording from the shared message map (utils/scanMessages.js)
// instead of a one-off string per call site — keeps this event's `message`
// field consistent with what the LCD and REST response say for the same
// errorType.
function emitScanError(errorType, extra) {
  const msg = getScanMessage(errorType);
  socketUtil.emitToAdmins('rfid:error', {
    title: msg.title,
    message: msg.body,
    timestamp: new Date(),
    ...extra,
  });
}

/**
 * Single source of truth for "what happens when a card is scanned."
 * Used by BOTH the serial/Arduino listener (rfidService.js) and the
 * REST fallback endpoint (rfidController.scanCard), so there is only
 * one place that decides check-in vs check-out — for members AND now
 * employees/coaches.
 */
async function processScan(cardId) {
  const uid = cardId.trim().toUpperCase();

  if (!/^[0-9A-F]{8,14}$/i.test(uid)) {
    throw httpError('Invalid cardId format', 400, 'invalid_format');
  }

  const card = await RFIDCard.findOne({ cardId: uid }).populate('userId').populate('coachId');

  // Split into two distinct cases (previously both collapsed into
  // 'card_invalid'): a UID that was never registered at all needs a
  // "please register this card" message, while a UID that *is*
  // registered but was deactivated by an admin needs an "access denied"
  // message — conflating them meant an unregistered card and a
  // deliberately-disabled one looked identical to whoever was standing
  // at the reader.
  if (!card) {
    emitScanError('card_unregistered', { uid });
    throw httpError('Card not found', 404, 'card_unregistered');
  }
  if (!card.active) {
    emitScanError('card_deactivated', { uid });
    throw httpError('Card is deactivated', 403, 'card_deactivated');
  }

  const now = new Date();

  // Duplicate scan prevention (10-second cooldown) — applies identically
  // to member and employee cards.
  if (card.lastScannedAt && (now - card.lastScannedAt) / 1000 < 10) {
    throw httpError('Duplicate scan prevented (wait 10 seconds)', 429, 'duplicate_scan');
  }

  // Which kind of card is this? Exactly one of userId/coachId should be
  // populated — registerCard enforces that at registration time.
  if (card.coachId) {
    return processEmployeeScan(card, now);
  }
  if (card.userId) {
    return processMemberScan(card, now);
  }

  // A card that's active but bound to neither — shouldn't be reachable
  // given registerCard's validation, but fail closed rather than assume.
  throw httpError('Card is not linked to a member or employee', 404, 'card_unregistered');
}

// ---------------------------------------------------------------------------
// Employee / coach attendance (Section B)
// ---------------------------------------------------------------------------
// Deliberately skips every subscription check — employee attendance must
// not require an active membership, per the requirement. The only gate is
// whether the coach account itself is active (mirrors the member-side
// isActive check below).
async function processEmployeeScan(card, now) {
  const coach = card.coachId;

  if (!coach.isActive) {
    emitScanError('employee_inactive', {
      uid: card.cardId,
      coachId: coach._id,
      fullname: coach.fullname,
    });
    throw httpError('This coach account has been deactivated', 403, 'employee_inactive');
  }

  card.lastScannedAt = now;
  await card.save();

  const startOfDay = startOfLocalDay(now);

  let attendance = await Attendance.findOne({
    coachId: coach._id,
    subjectType: 'employee',
    createdAt: { $gte: startOfDay },
    checkOut: { $exists: false },
  });

  let action = 'checkin';
  if (attendance) {
    attendance.checkOut = now;
    await attendance.save();
    action = 'checkout';
  } else {
    // One-Tap-Per-Day: an employee who already completed a full check-in/
    // check-out cycle today gets no second cycle, even after the 10s
    // cooldown has passed. Without this, nothing stopped repeated in/out
    // taps from logging unlimited attendance pairs in a single day.
    const alreadyCompletedToday = await Attendance.findOne({
      coachId: coach._id,
      subjectType: 'employee',
      createdAt: { $gte: startOfDay },
      checkOut: { $exists: true },
    });

    if (alreadyCompletedToday) {
      emitScanError('daily_attendance_completed', {
        uid: card.cardId,
        coachId: coach._id,
        fullname: coach.fullname,
      });
      throw httpError('Attendance already completed for today', 403, 'daily_attendance_completed');
    }

    attendance = await Attendance.create({
      coachId: coach._id,
      subjectType: 'employee',
      rfidCardId: card._id,
      checkIn: now,
    });
  }

  await AuditLog.create({
    action: `employee_rfid_${action}`,
    userId: coach._id, // AuditLog.userId is a generic actor reference; coaches use the same field as members here rather than adding a parallel coachId column to AuditLog for one action type.
    meta: { cardId: card.cardId, subjectType: 'employee' },
  });

  const attendanceEvent = {
    type: action,
    subjectType: 'employee',
    at: now,
    attendance: {
      _id: attendance._id,
      checkIn: attendance.checkIn,
      checkOut: attendance.checkOut,
    },
    // Kept as `user` (not `coach`) in the event payload on purpose —
    // rfidService.js's handleRFIDData reads `user.fullname` for the LCD
    // message regardless of subject type, and AdminliveAttendance.vue's
    // socket listener (useLiveAttendance) keys off the same shape. A
    // Coach document has the same `fullname` field a User does, so this
    // needs no special-casing on either consumer.
    user: {
      _id: coach._id,
      fullname: coach.fullname,
      email: coach.email,
    },
  };

  socketUtil.emitToAdmins('attendance', attendanceEvent);

  return { action, attendance, event: attendanceEvent, user: coach };
}

// ---------------------------------------------------------------------------
// Member attendance
// ---------------------------------------------------------------------------
async function processMemberScan(card, now) {
  const user = card.userId;

  // Section A fix: the member's own account status was never checked
  // before — only RFIDCard.active was. A deactivated member with a
  // still-active card and a still-valid subscription record could
  // previously check in.
  if (!user.isActive) {
    emitScanError('member_inactive', {
      uid: card.cardId,
      userId: user._id,
      fullname: user.fullname,
    });
    throw httpError('This member account has been deactivated', 403, 'member_inactive');
  }

  // Section A fix: previously one query (`status: 'active', endDate:
  // {$gte: now}`) collapsed three different situations into the same
  // generic "No active membership" message. Fetching the member's most
  // recent subscription (no filter) and branching lets each case say
  // something the front desk can actually act on.
  const subscription = await Subscription.findOne({ userId: user._id }).sort({ endDate: -1 });

  if (!subscription) {
    emitScanError('no_subscription', { uid: card.cardId, userId: user._id, fullname: user.fullname });
    throw httpError('No subscription on file', 403, 'no_subscription');
  }

  // Date is checked BEFORE the status field on purpose: `status` can be
  // set to 'expired' explicitly (e.g. by a background job) as well as
  // implied by endDate having passed while status still reads 'active'
  // (e.g. the job hasn't run yet). Checking status first would have
  // classified the first case as generic "inactive" rather than
  // "expired", even though the subscription document literally says
  // expired — the two scenarios need to stay distinguishable for the
  // LCD/frontend messaging (see utils/scanMessages.js), so the
  // authoritative signal (the date) is checked first.
  if (subscription.endDate < now) {
    emitScanError('subscription_expired', {
      uid: card.cardId,
      userId: user._id,
      fullname: user.fullname,
      expiredOn: subscription.endDate,
    });
    throw httpError('Subscription expired', 403, 'subscription_expired');
  }

  if (subscription.status !== 'active') {
    emitScanError('subscription_inactive', { uid: card.cardId, userId: user._id, fullname: user.fullname });
    throw httpError('Membership is inactive', 403, 'subscription_inactive');
  }

  card.lastScannedAt = now;
  await card.save();

  // Today's open session, from the DB — never from in-memory state
  const startOfDay = startOfLocalDay(now);

  let attendance = await Attendance.findOne({
    userId: user._id,
    createdAt: { $gte: startOfDay },
    checkOut: { $exists: false },
  });

  let action = 'checkin';
  if (attendance) {
    attendance.checkOut = now;
    await attendance.save();
    action = 'checkout';
  } else {
    // One-Tap-Per-Day: a member who already completed a full check-in/
    // check-out cycle today gets no second cycle, even after the 10s
    // cooldown has passed. Without this, nothing stopped repeated in/out
    // taps from logging unlimited attendance pairs in a single day.
    const alreadyCompletedToday = await Attendance.findOne({
      userId: user._id,
      subjectType: 'member',
      createdAt: { $gte: startOfDay },
      checkOut: { $exists: true },
    });

    if (alreadyCompletedToday) {
      emitScanError('daily_attendance_completed', {
        uid: card.cardId,
        userId: user._id,
        fullname: user.fullname,
      });
      throw httpError('Attendance already completed for today', 403, 'daily_attendance_completed');
    }

    attendance = await Attendance.create({
      userId: user._id,
      subjectType: 'member',
      rfidCardId: card._id,
      checkIn: now,
      // No admin present at a card scan to pick Regular/Student manually,
      // so fall back to the account's existing promo flag.
      memberType: user.studentPromoActive ? 'Student' : 'Regular',
    });

    // Session deduction (Group 3): only on a genuine new check-in, never
    // on the checkout branch above — one RFID-granted visit deducts
    // exactly one session, regardless of the check-in/check-out pair it
    // produces. No-ops for a Day Pass plan — see recordAttendanceSession.
    await subscriptionService.recordAttendanceSession(user._id);
  }

  await AuditLog.create({
    action: `rfid_${action}`,
    userId: user._id,
    meta: { cardId: card.cardId, subjectType: 'member' },
  });

  const attendanceEvent = {
    type: action,
    subjectType: 'member',
    at: now,
    attendance: {
      _id: attendance._id,
      checkIn: attendance.checkIn,
      checkOut: attendance.checkOut,
    },
    user: {
      _id: user._id,
      fullname: user.fullname,
      email: user.email,
    },
  };

  socketUtil.emitToAdmins('attendance', attendanceEvent);
  socketUtil.emitToUser(user._id, 'attendance', attendanceEvent);

  return { action, attendance, event: attendanceEvent, user };
}

module.exports = { processScan };