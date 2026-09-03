const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post(
  '/register',
  [
    body('fullname').notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('address').optional().isString().trim(),
    // Section D1: server-side enforcement, not just a disabled frontend
    // button — a request with this missing or false is rejected before
    // it ever reaches authService.registerUser.
    body('privacyNoticeAcknowledged')
      .custom((v) => v === true)
      .withMessage('You must acknowledge the Privacy Notice to register'),
  ],
  authController.register
);

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  authController.login
);

// `protect` here isn't for access control (anyone can log themselves
// out) — it's what populates req.user so authController.logout knows
// which account's tokenVersion to bump. Without it, logout can't
// actually invalidate anything server-side; it was previously a no-op
// wrapped around a 200 response.
router.post('/logout', protect, authController.logout);
router.post(
  '/forgot-password',
  [body('email').isEmail().withMessage('Valid email is required')],
  authController.forgotPassword
);
router.post(
  '/verify-reset-code',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('Code must be 6 digits').isNumeric().withMessage('Code must be numeric'),
  ],
  authController.verifyResetCode
);
router.post(
  '/reset-password',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('Code must be 6 digits').isNumeric().withMessage('Code must be numeric'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  authController.resetPassword
);

// Email verification
router.get('/verify-email/:token', authController.verifyEmail);
router.post(
  '/resend-verification',
  [body('email').isEmail().withMessage('Valid email is required')],
  authController.resendVerification
);

module.exports = router;