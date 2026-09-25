const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const oauthController = require('../controllers/oauthController');
const passport = require('../config/passport');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// ---- Google / Facebook OAuth ----
// Same underlying flow serves both the Login and Sign Up pages — the
// buttons on each just point at these two GET routes, and
// oauthService.handleOAuthProfile is what decides new-account vs.
// sign-in vs. conflict, not the page the user clicked from. See
// oauthController.js for the callback/exchange/link handlers and
// oauthService.js for that decision logic.
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/google/callback', oauthController.googleCallback);

router.get('/facebook', passport.authenticate('facebook', { scope: ['email'], session: false }));
router.get('/facebook/callback', oauthController.facebookCallback);

// Trades the one-time code from the /oauth/callback redirect for the
// actual { user, token } — called by the frontend's OAuthCallback.vue.
router.post('/oauth/exchange', [body('code').notEmpty().withMessage('Missing code')], oauthController.exchangeCode);

// Completes account-linking after the user has proven ownership of
// their existing account via a normal (protected) login — see
// oauthService.linkProviderToUser.
router.post('/link', protect, [body('ticket').notEmpty().withMessage('Missing ticket')], oauthController.linkAccount);

router.get('/me', protect, oauthController.me);

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