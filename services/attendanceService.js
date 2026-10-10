// services/attendanceService.js
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');
const subscriptionService = require('./subscriptionService');
const { getScanMessage } = require('../utils/scanMessages');
const { startOfLocalDay, formatLocalDateLabel } = require('../utils/localDate');
const cardLookup = require('./rfidCardLookup');
const { logUid } = require('../utils/uidHash');
const { normalizeUid } = require('../utils/normalizeUid');
const visitorPassService = require('./visitorPassService');
const memberAttendance = require('./memberAttendanceService');
const TempCardAssignment = require('../models/TempCardAssignment');
const User = require('../models/User');
const scanConfig = require('../utils/scanConfig');

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

// A bridge scanId becomes the attendance idempotency key. Namespaced so it can
// never collide with an admin-supplied requestId; a malformed id is ignored
// (a device must never be able to make a tap fail by sending a bad id).
function scanRequestId(scanId) {
  if (scanId === undefined || scanId === null || scanId === '') return undefined;
  try {
    return memberAttendance.cleanRequestId(`scan:${String(scanId).trim()}`);
  } catch {
    console.warn('[RFID] Ignoring malformed scanId');
    return undefined;
  }
}

// Sliding duplicate-SIGNAL filter (replaces the old fixed 10 s per-card
// cooldown). Returns true when this signal is a NEW physical tap.
//
//   accepted  : the card had been quiet for >= debounceMs  -> new tap
//   duplicate : another signal arrived < debounceMs ago     -> same tap; the
//               window is pushed forward so a card that is still on the reader
//               (and keeps re-sending) never turns into a second tap.
//
// The accept is ONE conditional update on the card document, so two requests
// carrying the same signal at the same instant cannot both be accepted. The
// window is measured between SIGNALS, not between actions, so deliberate taps
// 1.5 s (default) apart are never delayed by a leftover cooldown.
async function claimSignal(card, now) {
  const windowMs = scanConfig.debounceMs;
  if (windowMs <= 0) return true;
  const cutoff = new Date(now.getTime() - windowMs);
  const claimed = await RFIDCard.findOneAndUpdate(
    { _id: card._id, $or: [{ lastSignalAt: null }, { lastSignalAt: { $lt: cutoff } }] },
    { $set: { lastSignalAt: now, lastScannedAt: now } },
  );
  if (claimed) return true;
  // Duplicate: slide the window forward (never backwards).
  await RFIDCard.updateOne({ _id: card._id, lastSignalAt: { $lt: now } }, { $set: { lastSignalAt: now } });
  return false;
}

// If the tap failed for an UNEXPECTED reason (database error etc., not a
// business denial) release the claim so the member's immediate retap is not
// swallowed as a "duplicate" of a tap that never happened.
async function releaseSignal(card) {
  try {
    await RFIDCard.updateOne({ _id: card._id }, { $unset: { lastSignalAt: 1 } });
  } catch (e) {
    console.error('[RFID] Could not release scan claim', e.message);
  }
}

/**
 * Single source of truth for "what happens when a card is scanned."
 * Used by BOTH the serial/Arduino listener (rfidService.js) and the
 * REST endpoint (rfidController.scanCard), so there is only one place that
 * decides check-in vs check-out - for members AND employees/coaches.
 *
 * `opts.scanId` (optional) identifies ONE physical tap. A retry of the same
 * tap (lost response, bridge timeout) carries the same id and gets the original
 * result back instead of toggling again.
 */
async function processScan(cardId, opts = {}) {
  const raw = cardId;
  const uid = normalizeUid(cardId);
  const rid = scanRequestId(opts.scanId);

  // Safe debug logging: UID only, never passwords/secrets/PII.
  console.log(`[RFID] Attendance request - incoming: ${logUid(raw)} -> normalized: ${logUid(uid)}`);

  if (!/^[0-9A-F]{8,14}$/i.test(uid)) {
    console.log(`[RFID] Attendance request - incoming: ${logUid(raw)} -> normalized: ${logUid(uid)} -> match: no (invalid_format)`);
    throw httpError('Invalid cardId format', 400, 'invalid_format');
  }

  const card = await cardLookup.findByUid(uid).populate('userId').populate('coachId');
  console.log(`[RFID] Attendance request - incoming: ${logUid(raw)} -> normalized: ${logUid(uid)} -> match: ${card ? 'yes' : 'no'}`);

  // Unregistered vs deactivated are different messages on purpose (see
  // utils/scanMessages.js).
  if (!card) {
    emitScanError('card_unregistered', { uid });
    throw httpError('Card not found', 404, 'card_unregistered');
  }
  if (!card.active) {
    emitScanError('card_deactivated', { uid });
    throw httpError('Card is deactivated', 403, 'card_deactivated');
  }

  const now = new Date();

  // Same physical tap re-sent by the reader? (Applies to every card type.)
  if (!(await claimSignal(card, now))) {
    // A retried request for a tap that already succeeded must get that result,
    // not "duplicate" - the first attempt's own claim is what we just collided with.
    const prior = rid ? await memberAttendance.findReplay(rid) : null;
    if (prior) {
      const user = await User.findById(prior.attendance.userId);
      if (user) return { action: prior.action, attendance: prior.attendance, event: null, user, replayed: true };
    }
    throw httpError('Duplicate scan signal ignored', 429, 'duplicate_signal');
  }

  try {
    // Visitor / temporary pass: its own validation path. Checked BEFORE the
    // userId/coachId branches - a TEMPORARY card has neither, and must never
    // fall through to the "not linked" case or to member logic.
    if (card.cardType === 'TEMPORARY') {
      // Lent to an existing member: resolve to that member and use the normal
      // member rules. The tap is an alternative credential, not a new identity.
      if (card.memberAssignmentId) return await processMemberLoanScan(card, now, rid);
      // A spare card nobody currently holds grants nothing - and says so.
      if (visitorPassService.isUnassigned(card)) {
        emitScanError('temp_card_not_assigned', { uid: card.cardId });
        throw httpError('Temporary card is not assigned', 403, 'temp_card_not_assigned');
      }
      return await processVisitorScan(card, now);
    }

    // Exactly one of userId/coachId should be populated (registerCard enforces it).
    if (card.coachId) return await processEmployeeScan(card, now);
    if (card.userId) return await processMemberScan(card, now, null, rid);

    // Active but bound to neither - fail closed.
    throw httpError('Card is not linked to a member or employee', 404, 'card_unregistered');
  } catch (err) {
    if (!err.statusCode) await releaseSignal(card);
    throw err;
  }
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

  const startOfDay = startOfLocalDay(now);

  let attendance = await Attendance.findOne({
    coachId: coach._id,
    subjectType: 'employee',
    createdAt: { $gte: startOfDay },
    checkOut: { $exists: false },
  });

  let action = 'checkin';
  if (attendance) {
    // Atomic: only the tap that finds the row still open closes it.
    const closed = await Attendance.findOneAndUpdate(
      { _id: attendance._id, checkOut: { $exists: false } },
      { $set: { checkOut: now } },
      { new: true },
    );
    if (!closed) throw httpError('Duplicate scan prevented', 429, 'duplicate_scan');
    attendance = closed;
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
      attendanceType: 'EMPLOYEE',
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
// ---------------------------------------------------------------------------
// Visitor / temporary pass (one Manila-local day)
// ---------------------------------------------------------------------------
// Rules: card must be active (not revoked — checked by processScan), the
// current instant must be inside [validFrom, validUntil] to CHECK IN, and it
// behaves like a member's daily visit (tap = check-in, second tap = check-out,
// then done) — but with NO subscription check and NO session deduction, and it
// never creates or touches a User.
//
// Check-out is the event that ends the visit: in ONE operation it closes the
// Attendance row AND stamps the card's checkedOutAt, which flips the pass to
// CHECKED_OUT and releases the card for the next visitor (see
// visitorPassService). A visitor who is already inside may still check out
// after validUntil — otherwise a late tap would strand the visit open forever.

// `emit` is false for admin-entered attendance: a rejected manual entry is
// reported to the admin by the HTTP response, not as a "denied scan" popup.
function denyVisitor(errorType, message, status, card, name, emit, extra) {
  if (emit) emitScanError(errorType, { uid: card.cardId, fullname: name, ...extra });
  return httpError(message, status, errorType);
}

async function findOpenVisit(card, now) {
  // Visitor hardware is re-issued (even the same day, after a revoke), so
  // "today's visit" is counted only from the moment THIS pass was issued —
  // otherwise the previous visitor's completed visit would block the next.
  const since = card.assignedAt && card.assignedAt > startOfLocalDay(now)
    ? card.assignedAt
    : startOfLocalDay(now);
  const open = await Attendance.findOne({
    rfidCardId: card._id,
    createdAt: { $gte: since },
    checkOut: { $exists: false },
  });
  return { since, open };
}

function assertPassWindow(card, now, name, emit) {
  if (!card.validFrom || !card.validUntil) {
    throw denyVisitor('visitor_pass_expired', 'Visitor pass has no validity window', 403, card, name, emit);
  }
  if (now < card.validFrom) {
    throw denyVisitor('visitor_pass_not_yet_valid', 'Visitor pass is not valid yet', 403, card, name, emit, { validFrom: card.validFrom });
  }
  if (now > card.validUntil) {
    throw denyVisitor('visitor_pass_expired', 'Visitor pass expired', 403, card, name, emit, { expiredOn: card.validUntil });
  }
}

async function visitorCheckIn(card, now, { manual = false, adminId = null } = {}) {
  const name = card.visitorName || 'Visitor';
  const emit = !manual;
  assertPassWindow(card, now, name, emit);

  // The card document is the lock: only one caller can flip it from
  // "unused" to "checked in", so a double tap / two admins cannot create two
  // attendance rows for the same visit.
  const locked = await RFIDCard.findOneAndUpdate(
    { _id: card._id, active: true, checkedInAt: null, checkedOutAt: null },
    { $set: { checkedInAt: now, lastScannedAt: now } },
    { new: true },
  );
  if (!locked) {
    throw denyVisitor('daily_attendance_completed', 'This visitor pass has already been used for a visit', 403, card, name, emit);
  }

  let attendance;
  try {
    attendance = await Attendance.create({
      guestName: name,
      subjectType: 'member', // keeps the existing "Non-member" analytics bucket
      attendanceType: 'VISITOR',
      rfidCardId: card._id,
      memberType: 'Regular',
      checkIn: now,
      notes: manual ? 'Visitor pass (manually recorded by admin)' : 'Visitor pass',
    });
  } catch (err) {
    // Undo the lock so the pass is not left looking "inside" with no attendance.
    await RFIDCard.updateOne({ _id: card._id }, { $unset: { checkedInAt: 1 } }).catch(() => {});
    throw err;
  }
  card.checkedInAt = now;
  card.lastScannedAt = now;
  return finishVisitorEvent(card, attendance, 'checkin', name, now, adminId, manual);
}

async function visitorCheckOut(card, open, now, { manual = false, adminId = null } = {}) {
  const name = card.visitorName || 'Visitor';

  // Atomic: only the call that actually closes the row proceeds.
  const attendance = await Attendance.findOneAndUpdate(
    { _id: open._id, checkOut: { $exists: false } },
    { $set: { checkOut: now } },
    { new: true },
  );
  if (!attendance) {
    throw denyVisitor('duplicate_scan', 'This visitor has already checked out', 409, card, name, !manual);
  }

  // Card side of the same checkout. If this write were ever lost, the
  // attendance row is still correct and reconcilePass() repairs the card on
  // the next read/issue — the visitor's checkout itself must not fail for it.
  try {
    await RFIDCard.updateOne(
      { _id: card._id },
      { $set: { checkedOutAt: now, lastScannedAt: now, checkedInAt: card.checkedInAt || open.checkIn } },
    );
    card.checkedOutAt = now;
  } catch (err) {
    console.error('[RFID] Visitor checkout: card release write failed — will be reconciled', err);
  }
  return finishVisitorEvent(card, attendance, 'checkout', name, now, adminId, manual);
}

async function finishVisitorEvent(card, attendance, action, name, now, adminId, manual) {
  await AuditLog.create({
    action: `${manual ? 'admin_' : 'rfid_'}visitor_${action}`,
    ...(adminId ? { userId: adminId } : {}),
    meta: { cardId: card.cardId, subjectType: 'visitor', visitorName: name, ...(action === 'checkout' ? { cardReleased: true } : {}) },
  }).catch(() => {});

  const attendanceEvent = {
    type: action,
    subjectType: 'visitor',
    attendanceType: 'VISITOR',
    at: now,
    attendance: { _id: attendance._id, checkIn: attendance.checkIn, checkOut: attendance.checkOut },
    user: { fullname: name, visitor: true },
  };
  socketUtil.emitToAdmins('attendance', attendanceEvent);
  if (manual) socketUtil.emitToAdmins('stats:refresh');

  return { action, attendance, event: attendanceEvent, user: { fullname: name, visitor: true } };
}

async function processVisitorScan(card, now) {
  const name = card.visitorName || 'Visitor';
  const { since, open } = await findOpenVisit(card, now);

  // Someone already inside always gets to check out (even past validUntil).
  if (open) return visitorCheckOut(card, open, now);

  // Visit already finished on this pass.
  if (card.checkedOutAt) {
    throw denyVisitor('daily_attendance_completed', 'Attendance already completed for today', 403, card, name, true);
  }
  assertPassWindow(card, now, name, true);

  // Legacy / drifted rows: a completed visit with no checkedOutAt on the card.
  const completed = await Attendance.findOne({ rfidCardId: card._id, createdAt: { $gte: since }, checkOut: { $exists: true } });
  if (completed) {
    await visitorPassService.reconcilePass(card);
    throw denyVisitor('daily_attendance_completed', 'Attendance already completed for today', 403, card, name, true);
  }

  return visitorCheckIn(card, now);
}

// Admin-entered visitor attendance (Dashboard → Add Attendance → Visitor Pass).
// Goes through exactly the same check-in / check-out code as an RFID tap, so
// the pass, the attendance row and the card can never disagree.
async function manualVisitorAttendance({ passId, action, adminId }) {
  const card = await RFIDCard.findById(passId);
  if (!card || card.cardType !== 'TEMPORARY') throw httpError('Visitor pass not found', 404, 'not_found');
  if (!card.active) throw httpError('This visitor pass has been revoked', 409, 'revoked');

  await visitorPassService.reconcilePass(card);
  const now = new Date();
  const { open } = await findOpenVisit(card, now);

  if (action === 'checkout') {
    if (!open) throw httpError('This visitor is not currently checked in', 409, 'not_checked_in');
    return visitorCheckOut(card, open, now, { manual: true, adminId });
  }
  if (open) throw httpError('This visitor is already checked in', 409, 'already_checked_in');
  if (card.checkedOutAt) throw httpError('This visitor has already checked out — the visit is complete', 409, 'already_completed');
  return visitorCheckIn(card, now, { manual: true, adminId });
}

// The member-eligibility rules, shared by the RFID tap (below) and by
// temporary-card issuance (services/tempCardService.js) so the two can never
// drift apart. Pure check: it emits nothing and throws nothing. A temporary
// card never makes an ineligible member eligible.
//
// Date is checked BEFORE the status field on purpose: `status` can be set to
// 'expired' explicitly (e.g. by a background job) as well as implied by
// endDate having passed while status still reads 'active'. The two cases need
// to stay distinguishable for the LCD/frontend messaging (utils/scanMessages.js).
async function checkMemberEligibility(user, now = new Date()) {
  if (!user.isActive) {
    return { ok: false, errorType: 'member_inactive', status: 403, message: 'This member account has been deactivated' };
  }
  const subscription = await Subscription.findOne({ userId: user._id }).sort({ endDate: -1 });
  if (!subscription) {
    return { ok: false, errorType: 'no_subscription', status: 403, message: 'No subscription on file' };
  }
  if (subscription.endDate < now) {
    return {
      ok: false, errorType: 'subscription_expired', status: 403, message: 'Subscription expired',
      extra: { expiredOn: subscription.endDate },
    };
  }
  if (subscription.status !== 'active') {
    return { ok: false, errorType: 'subscription_inactive', status: 403, message: 'Membership is inactive' };
  }
  return { ok: true, subscription };
}

// A tap on a spare card that is lent to a member. Resolves the active
// assignment to the member, enforces assignment validity/expiry, then hands
// over to processMemberScan - the one place that applies subscription and
// attendance rules and deducts a session.
async function processMemberLoanScan(card, now, rid) {
  const deny = (errorType, message) => {
    emitScanError(errorType, { uid: card.cardId });
    return httpError(message, 403, errorType);
  };
  const assignment = await TempCardAssignment.findById(card.memberAssignmentId);
  if (!assignment) throw deny('temp_card_not_assigned', 'Temporary card is not assigned');

  // Expiry is enforced here, on the server, on every tap.
  if (assignment.status === 'ACTIVE' && assignment.expiresAt <= now) {
    await TempCardAssignment.updateOne({ _id: assignment._id, status: 'ACTIVE' }, { $set: { status: 'EXPIRED' } });
    throw deny('temp_card_expired', 'Temporary card has expired');
  }
  if (assignment.status === 'EXPIRED') throw deny('temp_card_expired', 'Temporary card has expired');
  if (assignment.status !== 'ACTIVE') throw deny('temp_card_not_assigned', 'Temporary card is not assigned');

  const user = await User.findById(assignment.memberId);
  if (!user) throw deny('temp_card_not_assigned', 'Temporary card is not assigned');

  return processMemberScan(card, now, { user, assignment }, rid);
}

// `via` is only set when the tap came from a temporary card:
// { user, assignment } - the member the assignment resolves to.
async function processMemberScan(card, now, via = null, rid) {
  const user = via ? via.user : card.userId;

  // Same rules as always (see checkMemberEligibility), now emitting the same
  // scan errors the front desk already sees.
  const eligibility = await checkMemberEligibility(user, now);
  if (!eligibility.ok) {
    emitScanError(eligibility.errorType, {
      uid: card.cardId,
      userId: user._id,
      fullname: user.fullname,
      ...(eligibility.extra || {}),
    });
    throw httpError(eligibility.message, eligibility.status, eligibility.errorType);
  }

  // Duplicate-signal filtering already happened in processScan (claimSignal).
  // Multiple sessions per day: an open session => Time-Out, otherwise a NEW
  // Time-In. The open/closed state always comes from the DB (never memory),
  // inside the member's lock, and the shared service makes a lost race a
  // duplicate, not a second row.
  const { action, attendance, replayed } = await memberAttendance.toggle({
    user,
    now,
    rfidCardId: card._id,
    // No admin present at a card scan to pick Regular/Student manually,
    // so fall back to the account's existing promo flag.
    memberType: user.studentPromoActive ? 'Student' : 'Regular',
    requestId: rid,
  });

  // A replay is a retried tap whose first attempt already audited/broadcast
  // everything; repeating that would double-announce one action.
  if (replayed) return { action, attendance, event: null, user, replayed: true };

  await AuditLog.create({
    action: `rfid_${action}`,
    userId: user._id,
    meta: {
      cardId: card.cardId,
      subjectType: 'member',
      ...(via ? { viaTempCard: true, assignmentId: via.assignment._id } : {}),
    },
  });

  const attendanceEvent = {
    type: action,
    subjectType: 'member',
    ...(via ? { viaTempCard: true } : {}),
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

module.exports = { processScan, manualVisitorAttendance, checkMemberEligibility };