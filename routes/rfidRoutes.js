const express = require('express');
const router = express.Router();
const rfidController = require('../controllers/rfidController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const { requireDeviceKey } = require('../middleware/deviceAuthMiddleware');

// ============================================================================
// RFID ROUTES - Complete REST API for RFID Management
// ============================================================================
//
// Routes Overview:
//
// ADMIN ONLY (protected, admin middleware):
// POST   /api/rfid/register           Register card to member
// GET    /api/rfid/logs               Get scan logs (paginated)
// GET    /api/rfid/today              Get today's attendance
// GET    /api/rfid/status             Check Arduino connection status
// GET    /api/rfid/member/:userId     Get member's RFID info
// PUT    /api/rfid/:cardId/deactivate Disable a card
// PUT    /api/rfid/:cardId/reassign   Move card to different member
//
// DEVICE AUTH (X-Device-Key header):
// POST   /api/rfid/scan               Process card scan from Arduino
//
// ============================================================================

// ============================================================================
// ADMIN ROUTES (require admin JWT)
// ============================================================================

// All admin routes are protected
router.use(protect, admin);

// Register RFID card to a member
// POST /api/rfid/register
// Body: { userId, cardId }
router.post('/register', rfidController.registerCard);

// Get RFID scan logs with pagination and date filtering
// GET /api/rfid/logs?page=1&limit=50&startDate=2024-01-01&endDate=2024-01-31
router.get('/logs', rfidController.getLogs);

// Get all attendance records for today
// GET /api/rfid/today
router.get('/today', rfidController.todayAttendance);

// Get Arduino connection status
// GET /api/rfid/status
router.get('/status', rfidController.getStatus);

// Get RFID card info for a specific member
// GET /api/rfid/member/:userId
router.get('/member/:userId', rfidController.getMemberRFID);

// Deactivate (disable) an RFID card
// PUT /api/rfid/:cardId/deactivate
router.put('/:cardId/deactivate', rfidController.deactivateCard);

// Reassign RFID card to a different member
// PUT /api/rfid/:cardId/reassign
// Body: { userId }
router.put('/:cardId/reassign', rfidController.reassignCard);

// ============================================================================
// DEVICE ROUTES (require X-Device-Key header)
// ============================================================================

// Process RFID card scan from Arduino
// POST /api/rfid/scan
// Header: X-Device-Key: <RFID_DEVICE_KEY from .env>
// Body: { cardId }
router.post('/scan', requireDeviceKey, rfidController.scanCard);

// ============================================================================

module.exports = router;