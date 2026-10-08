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
const cardLookup = require('./rfidCardLookup');
const { logUid } = require('../utils/uidHash');
const { normalizeUid } = require('../utils/normalizeUid');
const visitorPassService = require('./visitorPassService');

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
  const raw = cardId;
  const uid = normalizeUid(cardId);

  // Safe debug logging: UID only, never passwords/secrets/PII.
  // Single explicit line per tap (per diagnostics spec): raw → normalized
  // → match yes/no, so an attendance-mode failure is visible without
  // inferring it from the LCD.
  console.log(`[RFID] Attendance request — incoming: ${logUid(raw)} → normalized: ${logUid(uid)}`);

  if (!/^[0-9A-F]{8,14}$/i.test(uid)) {
    console.log(`[RFID] Attendance request — incoming: ${logUid(raw)} → normalized: ${logUid(uid)} → match: no (invalid_format)`);
    throw httpError('Invalid cardId format', 400, 'invalid_format');
  }

  const card = await cardLookup.findByUid(uid).populate('userId').populate('coachId');
  console.log(`[RFID] Attendance request — incoming: ${logUid(raw)} → normalized: ${logUid(uid)} → match: ${card ? 'yes' : 'no'}`);

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

  // Visitor / temporary pass: its own validation path. It must be checked
  // BEFORE the userId/coachId branches below — a TEMPORARY card has neither,
  // and must never fall through to the "not linked" case or to member logic.
  if (card.cardType === 'TEMPORARY') {
    return processVisitorScan(card, now);
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
      attendanceType: 'MEMBER',
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

module.exports = { processScan, manualVisitorAttendance };