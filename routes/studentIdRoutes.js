const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const studentIdController = require('../controllers/studentIdController');

router.use(protect);
router.post(
  '/submit',
  (req, res, next) => {
    upload.single('idPhoto')(req, res, (err) => {
      if (err) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'That image is too large. Maximum size is 5MB.'
            : err.message && err.message.includes('allowed_formats')
            ? 'Please upload a JPG, JPEG, PNG, or WEBP image.'
            : err.message || 'Could not upload the ID photo.';
        return res.status(400).json({ success: false, message });
      }
      next();
    });
  },
  studentIdController.submit
);
router.get('/my-status', studentIdController.getMyStatus);

module.exports = router;