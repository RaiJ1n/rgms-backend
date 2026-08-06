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
      return res.status(400).json({
        success: false,
        message: 'This card is already registered',
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

// ============================================================================
// ENDPOINT: Scan RFID Card (from Arduino)
// ============================================================================
//
// Route: POST /api/rfid/scan
// Auth: Device key (X-Device-Key header)
// Request Body: { cardId }
//
// This endpoint is called by the backend's rfidService when Arduino sends UID.
// It's exposed here as a fallback endpoint for testing or alternative hardware.
//
// Process:
// 1. Find card by UID
// 2. Verify card is active
// 3. Check membership status
// 4. Determine check-in or check-out
// 5. Record attendance
// 6. Broadcast via Socket.IO
//
// Error Codes:
// - 404: Card not found or inactive
// - 403: No active membership
// - 429: Duplicate scan within 10 seconds
//

exports.scanCard = async (req, res, next) => {
  try {
    const { cardId } = req.body;
    
    if (!cardId) {
      return res.status(400).json({
        success: false,
        message: 'cardId is required',
      });
    }
    
    // Find card (populated with user data)
    const card = await RFIDCard.findOne({ 
      cardId: cardId.toUpperCase() 
    }).populate('userId');
    
    if (!card || !card.active) {
      return res.status(404).json({
        success: false,
        message: 'Card not found or inactive',
      });
    }
    
    const now = new Date();
    
    // Duplicate scan prevention (10-second cooldown)
    if (card.lastScannedAt && (now - card.lastScannedAt) / 1000 < 10) {
      return res.status(429).json({
        success: false,
        message: 'Duplicate scan prevented (wait 10 seconds)',
      });
    }
    
    // Verify active membership
    const subscription = await Subscription.findOne({
      userId: card.userId._id,
      status: 'active',
      endDate: { $gte: now },
    });
    
    if (!subscription) {
      socketUtil.emitToAdmins('rfid:error', {
        uid: cardId,
        userId: card.userId._id,
        fullname: card.userId.fullname,
        message: 'Membership expired',
        timestamp: now,
      });
      
      return res.status(403).json({
        success: false,
        message: 'No active membership',
      });
    }
    
    // Update last scan time
    card.lastScannedAt = now;
    await card.save();
    
    // Get today's attendance record (check for open session)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    let attendance = await Attendance.findOne({
      userId: card.userId._id,
      createdAt: { $gte: startOfDay },
      checkOut: { $exists: false }, // No checkout yet = still checked in
    });
    
    let action = 'checkin';
    
    if (attendance && !attendance.checkOut) {
      // Already checked in, this is check-out
      attendance.checkOut = now;
      await attendance.save();
      action = 'checkout';
    } else {
      // New check-in
      attendance = new Attendance({
        userId: card.userId._id,
        rfidCardId: card._id,
        checkIn: now,
      });
      await attendance.save();
    }
    
    // Audit log
    await AuditLog.create({
      action: `rfid_${action}`,
      userId: card.userId._id,
      meta: { cardId: card.cardId },
    });
    
    // Build event payload
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
    
    // Broadcast to admins (live attendance dashboard)
    socketUtil.emitToAdmins('attendance', attendanceEvent);
    
    // Broadcast to member (their own notification)
    socketUtil.emitToUser(card.userId._id, 'attendance', attendanceEvent);
    
    const message = action === 'checkin' ? 'Checked in' : 'Checked out';
    console.log(`[RFID] ${message}: ${card.userId.fullname}`);
    
    res.json({
      success: true,
      message,
      data: attendance,
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// ENDPOINT: Get RFID Logs (Paginated)
// ============================================================================
//
// Route: GET /api/rfid/logs?page=1&limit=50&startDate=2024-01-01&endDate=2024-01-31
// Auth: Admin only
//
// Query Parameters:
// - page: Page number (default: 1)
// - limit: Records per page (default: 50, max: 100)
// - startDate: Filter start date (ISO format)
// - endDate: Filter end date (ISO format)
//
// Returns: Attendance records with member info
//

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