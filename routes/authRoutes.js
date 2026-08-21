const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');

const router = express.Router();

router.post(
  '/register',
  [
    body('fullname').notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('address').optional().isString().trim(),
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

router.post('/logout', authController.logout);
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