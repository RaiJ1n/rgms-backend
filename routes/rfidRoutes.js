const express = require('express');
const router = express.Router();
const rfidController = require('../controllers/rfidController');

router.post('/register', rfidController.registerCard);
router.post('/scan', rfidController.scanCard);
router.get('/logs', rfidController.getLogs);
router.get('/today', rfidController.todayAttendance);

module.exports = router;
