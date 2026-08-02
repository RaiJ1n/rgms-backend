const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');

// Register an RFID card to a member
exports.registerCard = async (req, res, next) => {
  try {
    const { userId, cardId } = req.body;
    if (!userId || !cardId) return res.status(400).json({ message: 'userId and cardId required' });

    let card = await RFIDCard.findOne({ cardId });
    if (card) return res.status(400).json({ message: 'Card already registered' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    card = new RFIDCard({ cardId, userId, assignedAt: new Date() });
    await card.save();
    socketUtil.emitToUser(userId, 'rfid:updated', { bound: true, cardId: card.cardId, active: card.active });
    return res.status(201).json({ message: 'Card registered', card });
  } catch (err) {
    next(err);
  }
};

// Scan card (check-in/check-out)
exports.scanCard = async (req, res, next) => {
  try {
    const { cardId } = req.body;
    if (!cardId) return res.status(400).json({ message: 'cardId required' });

    const card = await RFIDCard.findOne({ cardId }).populate('userId');
    if (!card || !card.active) return res.status(404).json({ message: 'Card not found or inactive' });

    const now = new Date();
    if (card.lastScannedAt && (now - card.lastScannedAt) / 1000 < 10) {
      return res.status(429).json({ message: 'Duplicate scan prevented' });
    }

    // Verify active membership
    const sub = await Subscription.findOne({ userId: card.userId._id, status: 'active', endDate: { $gte: now } });
    if (!sub) return res.status(403).json({ message: 'No active membership' });

    card.lastScannedAt = now;
    await card.save();

    // Determine if check-in or check-out
    let attendance = await Attendance.findOne({ userId: card.userId._id }).sort({ createdAt: -1 });
    let action = 'checkin';
    if (attendance && !attendance.checkOut) {
      attendance.checkOut = now;
      await attendance.save();
      action = 'checkout';
      // audit
      await AuditLog.create({ action: 'rfid_checkout', userId: card.userId._id, meta: { cardId: card.cardId } });
      // emit socket — admins get the live feed, the member's own room
      // gets it too so a future member-facing "you checked out" view has
      // something to listen for without touching this controller again.
      const attendanceEvent = {
        type: 'checkout',
        at: now,
        attendance: { _id: attendance._id, checkIn: attendance.checkIn, checkOut: attendance.checkOut },
        user: { _id: card.userId._id, fullname: card.userId.fullname, email: card.userId.email },
      };
      socketUtil.emitToAdmins('attendance', attendanceEvent);
      socketUtil.emitToUser(card.userId._id, 'attendance', attendanceEvent);
      return res.json({ message: 'Checked out', attendance });
    }

    attendance = new Attendance({ userId: card.userId._id, rfidCardId: card._id, checkIn: now });
    await attendance.save();
    // audit
    await AuditLog.create({ action: 'rfid_checkin', userId: card.userId._id, meta: { cardId: card.cardId } });
    // emit socket
    socketUtil.emitToAdmins('attendance', {
      type: 'checkin',
      at: now,
      attendance: { _id: attendance._id, checkIn: attendance.checkIn, checkOut: attendance.checkOut },
      user: { _id: card.userId._id, fullname: card.userId.fullname, email: card.userId.email },
    });
    socketUtil.emitToUser(card.userId._id, 'attendance', {
      type: 'checkin',
      at: now,
      attendance: { _id: attendance._id, checkIn: attendance.checkIn, checkOut: attendance.checkOut },
      user: { _id: card.userId._id, fullname: card.userId.fullname, email: card.userId.email },
    });
    return res.json({ message: 'Checked in', attendance });
  } catch (err) {
    next(err);
  }
};

exports.getLogs = async (req, res, next) => {
  try {
    const { startDate, endDate, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (startDate || endDate) filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);

    const logs = await Attendance.find(filter).populate('userId', 'fullname email').sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(parseInt(limit, 10));
    res.json({ data: logs });
  } catch (err) { next(err); }
};

exports.todayAttendance = async (req, res, next) => {
  try {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    const logs = await Attendance.find({ createdAt: { $gte: start, $lte: end } }).populate('userId', 'fullname email');
    res.json({ data: logs });
  } catch (err) { next(err); }
};