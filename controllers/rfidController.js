const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');
const rfidService = require('../services/rfidService');

exports.registerCard = async (req, res, next) => {
  try {
    const { userId, coachId, cardId } = req.body;

    if (!cardId) {
      return res.status(400).json({
        success: false,
        message: 'cardId is required',
      });
    }
    if (!userId && !coachId) {
      return res.status(400).json({
        success: false,
        message: 'Either userId or coachId is required',
      });
    }
    if (userId && coachId) {
      return res.status(400).json({
        success: false,
        message: 'A card can belong to a member or an employee, not both',
      });
    }

    // Validate UID format (hexadecimal, 8-14 characters)
    if (!/^[0-9A-F]{8,14}$/i.test(cardId)) {
      return res.status(400).json({
        success: false,
        message: 'cardId must be valid hexadecimal (8-14 characters)',
      });
    }

    // Check if card already registered
    const existing = await RFIDCard.findOne({ cardId: cardId.toUpperCase() });
    if (existing) {
      const sameOwner =
        (userId && existing.userId && existing.userId.toString() === userId) ||
        (coachId && existing.coachId && existing.coachId.toString() === coachId);
      return res.status(400).json({
        success: false,
        message: sameOwner
          ? 'This RFID card is already assigned to this account.'
          : 'This RFID card is already assigned to another account.',
      });
    }

    // Verify the owner exists in the right collection
    let ownerName;
    if (userId) {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      ownerName = user.fullname;
    } else {
      const coach = await Coach.findById(coachId);
      if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });
      ownerName = coach.fullname;
    }

    // Create RFID card document
    const card = new RFIDCard({
      cardId: cardId.toUpperCase(),
      userId: userId || undefined,
      coachId: coachId || undefined,
      active: true,
      assignedAt: new Date(),
    });

    await card.save();

    // Audit log
    await AuditLog.create({
      action: 'rfid_register',
      userId: req.user._id, // Admin who registered
      meta: { cardId: card.cardId, ownerId: userId || coachId, ownerType: userId ? 'member' : 'employee' },
    });

    // Notify member (if Socket.IO connected) — employees don't have a
    // member-side session to notify, so this only fires for userId.
    if (userId) {
      socketUtil.emitToUser(userId, 'rfid:updated', {
        bound: true,
        cardId: card.cardId,
        active: card.active,
      });
    }

    console.log(`[RFID] Card registered: ${cardId} → ${ownerName}`);

    res.status(201).json({
      success: true,
      message: 'Card registered successfully',
      data: card,
    });
  } catch (err) {
    next(err);
  }
};

exports.listCards = async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    const cards = await RFIDCard.find()
      .populate('userId', 'fullname email')
      .populate('coachId', 'fullname email')
      .sort({ createdAt: -1 })
      .limit(limitNum);

    res.json({ success: true, data: cards });
  } catch (err) {
    next(err);
  }
};

const attendanceService = require('../services/attendanceService');
const { getScanMessage } = require('../utils/scanMessages');
const { startOfLocalDay, endOfLocalDay, formatLocalDateLabel } = require('../utils/localDate');

exports.scanCard = async (req, res, next) => {
  try {
    const { cardId } = req.body;
    if (!cardId) {
      return res.status(400).json({ success: false, message: 'cardId is required' });
    }

    const { action, attendance, user } = await attendanceService.processScan(cardId);

    // Same message map the Arduino LCD reads from (utils/scanMessages.js)
    // — this REST fallback (used when no serial device is connected, or
    // by any other client that hits /rfid/scan directly) says exactly
    // the same thing a member would see on the physical reader.
    const msg = getScanMessage(action === 'checkin' ? 'success_checkin' : 'success_checkout');
    const eventTime = (action === 'checkin' ? attendance.checkIn : attendance.checkOut) || new Date();

    res.json({
      success: true,
      message: msg.title,
      detail: msg.body(user.fullname, eventTime.toLocaleTimeString()),
      data: attendance,
    });
  } catch (err) {
    // errors thrown by processScan already carry statusCode + a clean message
    if (err.statusCode) {
      const msg = getScanMessage(err.errorType);
      return res.status(err.statusCode).json({
        success: false,
        message: msg.title,
        detail: msg.body,
      });
    }
    next(err);
  }
};

exports.getLogs = async (req, res, next) => {
  try {
    const { startDate, endDate, page = 1, limit = 50 } = req.query;
    
    // Build filter
    const filter = {};
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    
    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;
    
    // Query — populate both possible owner fields; only one will ever be
    // set per document, so this is one query rather than branching per row.
    const logs = await Attendance.find(filter)
      .populate('userId', 'fullname email phone')
      .populate('coachId', 'fullname email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    // Total count
    const total = await Attendance.countDocuments(filter);
    
    res.json({
      success: true,
      data: logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.todayAttendance = async (req, res, next) => {
  try {
    const start = startOfLocalDay();
    const end = endOfLocalDay();

    const logs = await Attendance.find({
      createdAt: { $gte: start, $lte: end },
    })
      .populate('userId', 'fullname email phone')
      .populate('coachId', 'fullname email')
      .sort({ checkIn: 1 }); // Sort by check-in time
    
    res.json({
      success: true,
      data: logs,
      date: formatLocalDateLabel(start),
      count: logs.length,
    });
  } catch (err) {
    next(err);
  }
};

exports.getStatus = async (req, res, next) => {
  try {
    const status = rfidService.getStatus();
    
    res.json({
      success: true,
      data: status,
    });
  } catch (err) {
    next(err);
  }
};

exports.listPorts = async (req, res, next) => {
  try {
    const ports = await rfidService.listPorts();
    res.json({ success: true, data: ports });
  } catch (err) {
    next(err);
  }
};

exports.connectPort = async (req, res, next) => {
  try {
    const { port, baudRate } = req.body;
    if (!port) {
      return res.status(400).json({ success: false, message: 'port is required' });
    }

    const status = await rfidService.connectToPort(port, baudRate);
    res.json({ success: true, message: `Connected to ${port}`, data: status });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
};

exports.setRegistrationMode = async (req, res, next) => {
  try {
    const { enabled } = req.body;
    rfidService.setRegistrationMode(!!enabled);
    res.json({ success: true, data: { registrationMode: !!enabled } });
  } catch (err) {
    next(err);
  }
};

exports.getMemberRFID = async (req, res, next) => {
  try {
    const { userId } = req.params;
    
    const card = await RFIDCard.findOne({ userId }).populate('userId', 'fullname email');
    
    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'No RFID card assigned to this member',
      });
    }
    
    res.json({
      success: true,
      data: card,
    });
  } catch (err) {
    next(err);
  }
};

exports.getEmployeeRFID = async (req, res, next) => {
  try {
    const { coachId } = req.params;

    const card = await RFIDCard.findOne({ coachId }).populate('coachId', 'fullname email');

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'No RFID card assigned to this employee',
      });
    }

    res.json({
      success: true,
      data: card,
    });
  } catch (err) {
    next(err);
  }
};


exports.deactivateCard = async (req, res, next) => {
  try {
    const { cardId } = req.params;
    
    const card = await RFIDCard.findOne({ cardId: cardId.toUpperCase() });
    
    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Card not found',
      });
    }
    
    card.active = false;
    await card.save();
    
    await AuditLog.create({
      action: 'rfid_deactivate',
      userId: req.user._id,
      meta: { cardId },
    });
    
    res.json({
      success: true,
      message: 'Card deactivated',
      data: card,
    });
  } catch (err) {
    next(err);
  }
};


exports.reassignCard = async (req, res, next) => {
  try {
    const { cardId } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required',
      });
    }
    
    const card = await RFIDCard.findOne({ cardId: cardId.toUpperCase() });
    
    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Card not found',
      });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }
    
    const oldUserId = card.userId;
    card.userId = userId;
    card.assignedAt = new Date();
    await card.save();
    
    await AuditLog.create({
      action: 'rfid_reassign',
      userId: req.user._id,
      meta: { cardId, from: oldUserId, to: userId },
    });
    
    // Notify both members
    socketUtil.emitToUser(oldUserId, 'rfid:updated', { bound: false });
    socketUtil.emitToUser(userId, 'rfid:updated', {
      bound: true,
      cardId: card.cardId,
      active: card.active,
    });
    
    res.json({
      success: true,
      message: 'Card reassigned',
      data: card,
    });
  } catch (err) {
    next(err);
  }
};