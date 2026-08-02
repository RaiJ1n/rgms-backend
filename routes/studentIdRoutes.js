const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const studentIdController = require('../controllers/studentIdController');

router.use(protect);
router.post('/submit', upload.single('idPhoto'), studentIdController.submit);
router.get('/my-status', studentIdController.getMyStatus);

module.exports = router;