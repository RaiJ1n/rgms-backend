const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');
const rfidService = require('../services/rfidService');

// ============================================================================
// RFID CONTROLLER - REST API Endpoints for RFID Management
// ============================================================================
//
// Endpoints:
// - POST /api/rfid/register → Register new RFID card to a member OR employee
// - POST /api/rfid/scan → Handle card scan (from Arduino device)
// - GET /api/rfid/logs → Get RFID scan logs (pagination)
// - GET /api/rfid/today → Get today's attendance
// - GET /api/rfid/status → Get Arduino connection status
//
// ============================================================================

// ============================================================================
// ENDPOINT: Register RFID Card to a Member or Employee
// ============================================================================
//
// Route: POST /api/rfid/register
// Auth: Admin only
// Request Body: { userId, cardId } for a member, OR { coachId, cardId } for
// an employee/coach — exactly one of userId/coachId, never both. This is
// the one place that distinction is enforced; RFIDCard.js's schema allows
// both fields to technically exist so it can reuse the same document shape
// for either kind of card (see the comment there for why).
//
// Process:
// 1. Validate cardId format (should be UID from Arduino)
// 2. Validate exactly one of userId/coachId was provided
// 3. Check card not already registered
// 4. Create RFIDCard document
// 5. Broadcast update via Socket.IO
//
// Error Codes:
// - 400: Card already registered, missing fields, or both/neither of
//   userId+coachId supplied
// - 404: User or Coach not found
// - 422: Validation errors
//

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

// ============================================================================
// ENDPOINT: List Registered RFID Cards
// ============================================================================
//
// Route: GET /api/rfid/cards
// Auth: Admin only
//
// Was missing entirely — AdminrfidRegistration.vue's "Recently Registered
// Cards" table was actually calling GET /rfid/logs (Attendance records)
// and rendering fields (cardId, assignedAt, active) that only exist on
// RFIDCard, not Attendance. This is the endpoint that table should have
// been calling all along.
//

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

exports.scanCard = async (req, res, next) => {
  try {
    const { cardId } = req.body;
    if (!cardId) {
      return res.status(400).json({ success: false, message: 'cardId is required' });
    }

    const { action, attendance } = await attendanceService.processScan(cardId);
    const message = action === 'checkin' ? 'Checked in' : 'Checked out';

    res.json({ success: true, message, data: attendance });
  } catch (err) {
    // errors thrown by processScan already carry statusCode + a clean message
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
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

// ============================================================================
// ENDPOINT: Get Today's Attendance
// ============================================================================
//
// Route: GET /api/rfid/today
// Auth: Admin only
//
// Returns: All attendance records for today (check-in and check-out times),
// members and employees together — filter client-side by subjectType if a
// view needs to split them (see AdminliveAttendance.vue).
//

exports.todayAttendance = async (req, res, next) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    
    const logs = await Attendance.find({
      createdAt: { $gte: start, $lte: end },
    })
      .populate('userId', 'fullname email phone')
      .populate('coachId', 'fullname email')
      .sort({ checkIn: 1 }); // Sort by check-in time
    
    res.json({
      success: true,
      data: logs,
      date: start.toISOString().split('T')[0],
      count: logs.length,
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// ENDPOINT: Get Arduino Connection Status
// ============================================================================
//
// Route: GET /api/rfid/status
// Auth: Admin only
//
// Returns: Current Arduino connection status
//

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

// ============================================================================
// ENDPOINT: List Available Serial Ports
// ============================================================================
//
// Route: GET /api/rfid/ports
// Auth: Admin only
//

exports.listPorts = async (req, res, next) => {
  try {
    const ports = await rfidService.listPorts();
    res.json({ success: true, data: ports });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// ENDPOINT: Connect to a Specific Serial Port
// ============================================================================
//
// Route: POST /api/rfid/connect
// Auth: Admin only
// Request Body: { port, baudRate? }
//

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

// ============================================================================
// ENDPOINT: Toggle Registration Mode
// ============================================================================
//
// Route: POST /api/rfid/registration-mode
// Auth: Admin only
// Request Body: { enabled: boolean }
//

exports.setRegistrationMode = async (req, res, next) => {
  try {
    const { enabled } = req.body;
    rfidService.setRegistrationMode(!!enabled);
    res.json({ success: true, data: { registrationMode: !!enabled } });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// ENDPOINT: Get Member's RFID Card Info
// ============================================================================
//
// Route: GET /api/rfid/member/:userId
// Auth: Admin only
//

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

// ============================================================================
// ENDPOINT: Get Employee's RFID Card Info
// ============================================================================
//
// Route: GET /api/rfid/employee/:coachId
// Auth: Admin only
//
// Mirrors getMemberRFID above — new endpoint for employee cards rather
// than overloading the same route with a mixed-type param, since the two
// need different populate targets (User vs Coach).
//

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

// ============================================================================
// ENDPOINT: Deactivate RFID Card
// ============================================================================
//
// Route: PUT /api/rfid/:cardId/deactivate
// Auth: Admin only
//
// Disables an RFID card (useful when lost or stolen) — works for both
// member and employee cards unchanged, since it only ever touches `active`.
//

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

// ============================================================================
// ENDPOINT: Reassign RFID Card to a Different Member
// ============================================================================
//
// Route: PUT /api/rfid/:cardId/reassign
// Auth: Admin only
// Request Body: { userId }
//
// Unchanged from before — member-to-member reassignment only. Reassigning
// an employee card to a different coach, or converting a card between
// member/employee ownership, isn't exposed here; that's a deliberately
// narrower operation an admin can already achieve via deactivate + a fresh
// registerCard call, which keeps the audit trail (who was assigned when)
// intact rather than silently rewriting card history.
//

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