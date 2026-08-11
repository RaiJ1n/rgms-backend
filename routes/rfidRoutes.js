const express = require('express');
const router = express.Router();
const rfidController = require('../controllers/rfidController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const { requireDeviceKey } = require('../middleware/deviceAuthMiddleware');

router.post('/scan', requireDeviceKey, rfidController.scanCard);

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

// List available serial ports with USB metadata (Port Selector dropdown)
// GET /api/rfid/ports
router.get('/ports', rfidController.listPorts);

// Connect to a specific serial port
// POST /api/rfid/connect
// Body: { port, baudRate? }
router.post('/connect', rfidController.connectPort);

// Toggle registration mode (Bind/Register UI open/close)
// POST /api/rfid/registration-mode
// Body: { enabled }
router.post('/registration-mode', rfidController.setRegistrationMode);

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

module.exports = router;