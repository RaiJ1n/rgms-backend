const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const socketUtil = require('../utils/socket');
const rfidService = require('../services/rfidService');

// ============================================================================
// RFID CONTROLLER - REST API Endpoints for RFID Management
// ============================================================================
//
// Endpoints:
// - POST /api/rfid/register → Register new RFID card to member
// - POST /api/rfid/scan → Handle card scan (from Arduino device)
// - GET /api/rfid/logs → Get RFID scan logs (pagination)
// - GET /api/rfid/today → Get today's attendance
// - GET /api/rfid/status → Get Arduino connection status
//
// ============================================================================

// ============================================================================
// ENDPOINT: Register RFID Card to Member
// ============================================================================
// 
// Route: POST /api/rfid/register
// Auth: Admin only
// Request Body: { userId, cardId }
// 
// Process:
// 1. Validate cardId format (should be UID from Arduino)
// 2. Check card not already registered
// 3. Create RFIDCard document
// 4. Broadcast update via Socket.IO
//
// Error Codes:
// - 400: Card already registered or missing fields
// - 404: User not found
// - 422: Validation errors
//

exports.registerCard = async (req, res, next) => {
  try {
    const { userId, cardId } = req.body;
    
    // Validate required fields
    if (!userId || !cardId) {
      return res.status(400).json({
        success: false,
        message: 'userId and cardId are required',
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
      const sameMember = existing.userId && existing.userId.toString() === userId;
      return res.status(400).json({
        success: false,
        message: sameMember
          ? 'This RFID card is already assigned to this member.'
          : 'This RFID card is already assigned to another member.',
      });
    }
    
    // Verify user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }
    
    // Create RFID card document
    const card = new RFIDCard({
      cardId: cardId.toUpperCase(),
      userId,
      active: true,
      assignedAt: new Date(),
    });
    
    await card.save();
    
    // Audit log
    await AuditLog.create({
      action: 'rfid_register',
      userId: req.user._id, // Admin who registered
      meta: { cardId: card.cardId, memberId: userId },
    });
    
    // Notify member (if Socket.IO connected)
    socketUtil.emitToUser(userId, 'rfid:updated', {
      bound: true,
      cardId: card.cardId,
      active: card.active,
    });
    
    console.log(`[RFID] Card registered: ${cardId} → ${user.fullname}`);
    
    res.status(201).json({
      success: true,
      message: 'Card registered successfully',
      data: card,
    });
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
    
    // Query
    const logs = await Attendance.find(filter)
      .populate('userId', 'fullname email phone')
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
// Returns: All attendance records for today (check-in and check-out times)
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
// Returns every serial port Windows currently reports, with USB metadata
// and an isArduino flag (matched against known Arduino/USB-serial chipset
// VID/PIDs — see rfidService.js). Powers the Port Selector dropdown in
// AdminSettings.vue; the frontend re-calls this on "Refresh" and on page
// load, exactly like Arduino IDE's Tools → Port re-scanning.
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
// Opens a real serial connection to the requested port (closing whatever
// was previously open first) and persists the choice — by USB metadata,
// not just the COM string — so a server restart can re-find the same
// physical device even if Windows later assigns it a different COM number.
//
// Error Codes:
// - 400: missing/invalid port or baud rate
// - 404: requested port no longer exists (e.g. unplugged)
// - 409: port could not be opened (already in use by another program, etc.)
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
// Called when the Bind RFID Card modal (EditMember.vue) or the Register
// New Card page (AdminrfidRegistration.vue) opens/closes. While enabled,
// scans skip the normal check-in/out attempt so an unregistered card
// being bound doesn't show "Access Denied" on the Arduino's LCD.
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
// Returns: RFID card details for a specific member
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
// ENDPOINT: Deactivate RFID Card
// ============================================================================
//
// Route: PUT /api/rfid/:cardId/deactivate
// Auth: Admin only
//
// Disables an RFID card (useful when lost or stolen)
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
// ENDPOINT: Reassign RFID Card to Different Member
// ============================================================================
//
// Route: PUT /api/rfid/:cardId/reassign
// Auth: Admin only
// Request Body: { userId }
//
// Transfers card from one member to another
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