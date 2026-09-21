const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');
const studentIdController = require('../controllers/studentIdController');

router.use(protect);
router.post(
  '/submit',
  (req, res, next) => {
    // Same pattern as userRoutes.js's medical-document upload: multer/
    // Cloudinary errors (bad file type, upload failure) call next(err)
    // directly, bypassing the route handler entirely — without this
    // wrapper they fell through to the generic error middleware, which
    // has no case for them and returns an unhelpful 500 (or, for a
    // thrown storage error, whatever statusCode happens to be on it) —
    // "investigate the actual reason instead of hiding it" per spec.
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