const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const oauthController = require('../controllers/oauthController');
const passport = require('../config/passport');
const clientOrigins = require('../config/clientOrigins');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

const CLIENT_URL = clientOrigins[0] || 'http://localhost:5173';

// Google/Facebook strategies are only registered in config/passport.js when their env vars are present
// Without this guard, clicking the button
function requireProviderConfigured(provider, isConfigured) {
  return (req, res, next) => {
    if (!isConfigured) {
      const params = new URLSearchParams({ oauthError: '1', provider, reason: 'not_configured' });
      return res.redirect(`${CLIENT_URL}/login?${params.toString()}`);
    }
    next();
  };
}

const isGoogleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const isFacebookConfigured = Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

// Google / Facebook OAuth Same underlying flow serves both the Login and Sign Up pages
router.get(
  '/google',
  requireProviderConfigured('google', isGoogleConfigured),
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);
router.get('/google/callback', oauthController.googleCallback);

router.get(
  '/facebook',
  requireProviderConfigured('facebook', isFacebookConfigured),
  passport.authenticate('facebook', { scope: ['email'], session: false })
);
router.get('/facebook/callback', oauthController.facebookCallback);

// Trades the one-time code from the /oauth/callback redirect for the actual { user, token }
router.post('/oauth/exchange', [body('code').notEmpty().withMessage('Missing code')], oauthController.exchangeCode);

// Completes account-linking after the user has proven ownership of their existing account via a normal
router.post('/link', protect, [body('ticket').notEmpty().withMessage('Missing ticket')], oauthController.linkAccount);

router.get('/me', protect, oauthController.me);

router.post(
  '/register',
  [
    body('fullname').notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('address').optional().isString().trim(),
    // server-side enforcement, not just a disabled frontend button
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

// `protect` here isn't for access control (anyone can log themselves out)
// `protect` here isn't for access control (anyone can log themselves out) — it's what populates req.user
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