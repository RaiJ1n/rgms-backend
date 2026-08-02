const express = require('express');
const router = express.Router();
const rfidController = require('../controllers/rfidController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const { requireDeviceKey } = require('../middleware/deviceAuthMiddleware');

router.post('/register', protect, admin, rfidController.registerCard);
router.get('/logs', protect, admin, rfidController.getLogs);
router.get('/today', protect, admin, rfidController.todayAttendance);

router.post('/scan', requireDeviceKey, rfidController.scanCard);

module.exports = router;