const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');
const rfidService = require('../services/rfidService');
const { normalizeUid } = require('../utils/normalizeUid');

exports.registerCard = async (req, res, next) => {
  try {
    const { userId, coachId } = req.body;
    // Accept `uid` as an alias — some hardware/clients send { uid }
    // while the documented contract is { cardId }.
    const rawCardId = req.body.cardId ?? req.body.uid;

    if (!rawCardId) {
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

    // Normalize on BIND side (same util as SCAN side): strips spaces,
    // dashes, colons, trims \r\n, uppercases. "A1 B2 C3 D4" and
    // "a1b2c3d4" both bind as "A1B2C3D4".
    const cardId = normalizeUid(rawCardId);
    console.log(`[RFID] Bind request — incoming: ${String(rawCardId).trim()} → normalized: ${cardId}`);

    // Validate UID format (hexadecimal, 8-14 characters)
    if (!/^[0-9A-F]{8,14}$/i.test(cardId)) {
      return res.status(400).json({
        success: false,
        message: 'cardId must be valid hexadecimal (8-14 characters)',
      });
    }

    // Check if card already registered (normalized, so "A1 B2 C3 D4"
    // can never silently duplicate "A1B2C3D4")
    const existing = await RFIDCard.findOne({ cardId });
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
      cardId,
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
    // All admins (drives the bind modal + any serial bridge relay).
    socketUtil.emitToAdmins('rfid:bound', {
      cardId: card.cardId,
      ownerId: userId || coachId,
      ownerType: userId ? 'member' : 'employee',
      at: new Date(),
    });

    console.log(`[RFID] Card registered: ${cardId} → ${ownerName}`);

    // Push the binding result to the physical LCD when a serial reader is
    // attached to THIS backend instance. Without this, a successful bind
    // left the LCD sitting on the earlier "Card detected" ack with no
    // confirmation. No-op when no serial port is open (e.g. VPS
    // deployment — see scripts/rfidBridge.js, which relays the `rfid:bound`
    // socket event to its local Arduino instead).
    rfidService.sendToArduino(`RFID BOUND|${card.cardId.slice(0, 16)}`);

    res.status(201).json({
      success: true,
      message: 'Card registered successfully',
      data: card,
      lcd: { line1: 'RFID BOUND', line2: card.cardId.slice(0, 16) },
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
    // Accept `uid` alias (hardware often sends { uid }) alongside { cardId }.
    const rawCardId = req.body.cardId ?? req.body.uid;
    if (!rawCardId) {
      return res.status(400).json({ success: false, message: 'cardId is required' });
    }
    const cardId = normalizeUid(rawCardId);
    console.log(`[RFID] REST scan — incoming: ${String(rawCardId).trim()} → normalized: ${cardId}`);

    // Binding-mode router (mirrors the serial path in
    // services/rfidService.js handleRFIDData): while an admin has binding
    // mode enabled, a tap is a registration candidate — NOT an attendance
    // scan. A new/unregistered UID is expected here and must NOT fall
    // through to processScan (which would reject it as card_unregistered /
    // "RFID NOT REGISTERED"). Broadcast it so bind UIs can auto-fill, then
    // return without any attendance validation.
    if (rfidService.getStatus().registrationMode) {
      socketUtil.emitToAdmins('rfid:scanned', { cardId, at: new Date() });
      console.log(`[RFID] OPERATION: BINDING (REST) — captured ${cardId} for registration (attendance skipped)`);
      return res.json({
        success: true,
        bindingMode: true,
        message: 'Card detected — ready to bind',
        data: { cardId },
        // LCD lines for serial-bridge deployments (scripts/rfidBridge.js):
        // the bridge writes these to its local Arduino so the physical
        // reader acknowledges the tap even though this backend (VPS) has
        // no USB serial attached.
        lcd: { line1: 'Card detected', line2: cardId.slice(0, 16) },
      });
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
      lcd:
        action === 'checkin'
          ? { line1: msg.lcdLine1, line2: user.fullname.slice(0, 16), stage2: msg.lcdStage2 }
          : { line1: msg.lcdLine1, line2: user.fullname.slice(0, 16), stage2: msg.lcdStage2 },
    });
  } catch (err) {
    // errors thrown by processScan already carry statusCode + a clean message
    if (err.statusCode) {
      const msg = getScanMessage(err.errorType);
      return res.status(err.statusCode).json({
        success: false,
        message: msg.title,
        detail: msg.body,
        lcd: { line1: msg.lcdLine1, line2: msg.lcdLine2 },
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

exports.disconnectPort = async (req, res, next) => {
  try {
    const status = await rfidService.disconnectPort();
    res.json({ success: true, message: 'RFID disconnected', data: status });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
};

exports.setRegistrationMode = async (req, res, next) => {
  try {
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const enabled = body.enabled;
    // Optional binding context: which flow + which pre-selected owner.
    // EditMember bind modal sends { enabled:true, mode:'bind', userId };
    // the Register page sends { enabled:true, mode:'register' } and updates
    // userId/coachId later once an owner is picked (capture-only until then).
    const mode = body.mode === 'bind' ? 'bind' : 'register';
    const userId = body.userId || null;
    const coachId = body.coachId || null;
    if (userId && coachId) {
      return res.status(400).json({ success: false, message: 'Provide userId or coachId, not both' });
    }
    rfidService.setRegistrationMode(!!enabled, {
      mode,
      userId,
      coachId,
      startedBy: req.user?._id,
    });
    res.json({ success: true, data: rfidService.getStatus().binding });
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
    const cardId = normalizeUid(req.params.cardId);
    
    const card = await RFIDCard.findOne({ cardId });
    
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
      meta: { cardId: card.cardId },
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
    const cardId = normalizeUid(req.params.cardId);
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required',
      });
    }
    
    const card = await RFIDCard.findOne({ cardId });
    
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

// Unbind (fully remove) an RFID card so the old UID no longer
// authenticates anyone. DELETE /api/rfid/:cardId (admin only).
// Distinct from deactivate (which keeps the row, active=false):
// unbind deletes the RFIDCard document and verifies removal.
exports.unbindCard = async (req, res, next) => {
  try {
    const cardId = normalizeUid(req.params.cardId);
    const card = await RFIDCard.findOne({ cardId });
    if (!card) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }
    const ownerId = card.userId || card.coachId;
    await card.deleteOne();
    await AuditLog.create({
      action: 'rfid_unbind',
      userId: req.user._id,
      meta: { cardId },
    });
    if (ownerId) socketUtil.emitToUser(ownerId, 'rfid:updated', { bound: false });
    console.log(`[RFID] Card unbound: ${cardId}`);
    res.json({ success: true, message: 'Card unbound — it will no longer authenticate', data: { cardId } });
  } catch (err) {
    next(err);
  }
};