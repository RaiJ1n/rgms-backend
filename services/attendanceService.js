// services/attendanceService.js
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
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
 * one place that decides check-in vs check-out.
 */
async function processScan(cardId) {
  const uid = cardId.trim().toUpperCase();

  if (!/^[0-9A-F]{8,14}$/i.test(uid)) {
    throw httpError('Invalid cardId format', 400, 'invalid_format');
  }

  const card = await RFIDCard.findOne({ cardId: uid }).populate('userId');
  if (!card || !card.active) {
    socketUtil.emitToAdmins('rfid:error', {
      uid,
      message: 'Card not found or inactive',
      timestamp: new Date(),
    });
    throw httpError('Card not found or inactive', 404, 'card_invalid');
  }

  const now = new Date();

  // Duplicate scan prevention (10-second cooldown)
  if (card.lastScannedAt && (now - card.lastScannedAt) / 1000 < 10) {
    throw httpError('Duplicate scan prevented (wait 10 seconds)', 429, 'duplicate_scan');
  }

  // Verify active membership
  const subscription = await Subscription.findOne({
    userId: card.userId._id,
    status: 'active',
    endDate: { $gte: now },
  });

  if (!subscription) {
    socketUtil.emitToAdmins('rfid:error', {
      uid,
      userId: card.userId._id,
      fullname: card.userId.fullname,
      message: 'No active membership',
      timestamp: now,
    });
    throw httpError('No active membership', 403, 'no_subscription');
  }

  card.lastScannedAt = now;
  await card.save();

  // Today's open session, from the DB — never from in-memory state
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let attendance = await Attendance.findOne({
    userId: card.userId._id,
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
      userId: card.userId._id,
      rfidCardId: card._id,
      checkIn: now,
      // No admin present at a card scan to pick Regular/Student manually,
      // so fall back to the account's existing promo flag.
      memberType: card.userId.studentPromoActive ? 'Student' : 'Regular',
    });
  }

  await AuditLog.create({
    action: `rfid_${action}`,
    userId: card.userId._id,
    meta: { cardId: card.cardId },
  });

  const attendanceEvent = {
    type: action,
    at: now,
    attendance: {
      _id: attendance._id,
      checkIn: attendance.checkIn,
      checkOut: attendance.checkOut,
    },
    user: {
      _id: card.userId._id,
      fullname: card.userId.fullname,
      email: card.userId.email,
    },
  };

  socketUtil.emitToAdmins('attendance', attendanceEvent);
  socketUtil.emitToUser(card.userId._id, 'attendance', attendanceEvent);

  return { action, attendance, event: attendanceEvent, user: card.userId };
}

module.exports = { processScan };