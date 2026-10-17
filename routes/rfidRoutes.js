const express = require('express');
const router = express.Router();
const rfidController = require('../controllers/rfidController');
const tempCardController = require('../controllers/tempCardController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const { requireDeviceKey } = require('../middleware/deviceAuthMiddleware');

router.post('/scan', requireDeviceKey, rfidController.scanCard);

// Device-key status for the local serial bridge (scripts/rfidBridge.js)
// The bridge has no admin JWT — only x-device-key — so it can never call the admin-protected GET /status below
router.get('/device-status', requireDeviceKey, rfidController.getDeviceStatus);

// Device-key connectivity probe (bridge start-up self-test + rfidDiagnose.js)
router.get('/ping', requireDeviceKey, rfidController.ping);

// All admin routes are protected
router.use(protect, admin);

// Register RFID card to a member
router.post('/register', rfidController.registerCard);

// Get RFID scan logs with pagination and date filtering
router.get('/logs', rfidController.getLogs);

// Excel export of EVERY session matching the same filters as /logs
router.get('/logs/export', rfidController.exportLogs);

// List registered RFID cards (member + employee), most recent first
router.get('/cards', rfidController.listCards);

// Get all attendance records for today
router.get('/today', rfidController.todayAttendance);

// Get Arduino connection status
router.get('/status', rfidController.getStatus);

// List available serial ports with USB metadata (Port Selector dropdown)
router.get('/ports', rfidController.listPorts);

// Connect to a specific serial port
router.post('/connect', rfidController.connectPort);

// Disconnect the current serial port (idempotent — safe to call while already disconnected)
router.post('/disconnect', rfidController.disconnectPort);

// Toggle registration mode (Bind/Register UI open/close)
router.post('/registration-mode', rfidController.setRegistrationMode);

// Visitor / temporary passes (one Manila-local day)
router.post('/temporary', rfidController.issueTemporaryCard);
router.get('/temporary', rfidController.listTemporaryCards);
router.patch('/temporary/:id/revoke', rfidController.revokeTemporaryCard);

// Temporary cards for MEMBERS who forgot their own card + spare-card inventory
router.get('/temporary/members', tempCardController.searchMembers);
router.post('/temporary/member-assignments', tempCardController.issueToMember);
router.post('/temporary/member-assignments/:id/revoke', tempCardController.revokeAssignment);
router.post('/temporary/return', tempCardController.returnCard);
router.get('/temporary/inventory', tempCardController.inventory);

// Get RFID card info for a specific member
router.get('/member/:userId', rfidController.getMemberRFID);

// Get RFID card info for a specific employee/coach
router.get('/employee/:coachId', rfidController.getEmployeeRFID);

// Deactivate (disable) an RFID card
router.put('/:cardId/deactivate', rfidController.deactivateCard);

// Unbind (fully remove) an RFID card — old UID stops authenticating
router.delete('/:cardId', rfidController.unbindCard);

// Reassign RFID card to a different member
router.put('/:cardId/reassign', rfidController.reassignCard);

module.exports = router;