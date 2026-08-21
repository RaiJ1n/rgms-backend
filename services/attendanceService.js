// services/attendanceService.js
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');

const httpError = (message, statusCode, errorType) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.errorType = errorType; // lets callers distinguish cases if needed
  return err;
};

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
  if (!card || !card.active) {
    socketUtil.emitToAdmins('rfid:error', {
      uid,
      message: 'Card not found or inactive',
      timestamp: new Date(),
    });
    throw httpError('Card not found or inactive', 404, 'card_invalid');
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
  throw httpError('Card is not linked to a member or employee', 404, 'card_invalid');
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
    socketUtil.emitToAdmins('rfid:error', {
      uid: card.cardId,
      coachId: coach._id,
      fullname: coach.fullname,
      message: 'This coach account has been deactivated',
      timestamp: now,
    });
    throw httpError('This coach account has been deactivated', 403, 'employee_inactive');
  }

  card.lastScannedAt = now;
  await card.save();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

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
    socketUtil.emitToAdmins('rfid:error', {
      uid: card.cardId,
      userId: user._id,
      fullname: user.fullname,
      message: 'This member account has been deactivated',
      timestamp: now,
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
    socketUtil.emitToAdmins('rfid:error', {
      uid: card.cardId,
      userId: user._id,
      fullname: user.fullname,
      message: 'This member has no subscription on file',
      timestamp: now,
    });
    throw httpError('No subscription on file', 403, 'no_subscription');
  }

  if (subscription.status !== 'active') {
    socketUtil.emitToAdmins('rfid:error', {
      uid: card.cardId,
      userId: user._id,
      fullname: user.fullname,
      message: 'This member\'s membership is marked inactive',
      timestamp: now,
    });
    throw httpError('Membership is inactive', 403, 'subscription_inactive');
  }

  if (subscription.endDate < now) {
    socketUtil.emitToAdmins('rfid:error', {
      uid: card.cardId,
      userId: user._id,
      fullname: user.fullname,
      message: `This member's subscription expired on ${subscription.endDate.toLocaleDateString()}`,
      timestamp: now,
    });
    throw httpError('Subscription expired', 403, 'subscription_expired');
  }

  card.lastScannedAt = now;
  await card.save();

  // Today's open session, from the DB — never from in-memory state
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

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
    attendance = await Attendance.create({
      userId: user._id,
      subjectType: 'member',
      rfidCardId: card._id,
      checkIn: now,
      // No admin present at a card scan to pick Regular/Student manually,
      // so fall back to the account's existing promo flag.
      memberType: user.studentPromoActive ? 'Student' : 'Regular',
    });
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