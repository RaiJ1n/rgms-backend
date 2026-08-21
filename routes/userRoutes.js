const express = require('express');
const { body } = require('express-validator');
const userController = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

router.use(protect);
router.get('/profile', userController.getProfile);
router.put(
  '/profile',
  [
    body('fullname').trim().notEmpty().withMessage('Full name is required'),
    body('email').optional().trim().isEmail().withMessage('Enter a valid email').normalizeEmail(),
    body('age').optional().isInt({ min: 0, max: 120 }).withMessage('Enter a valid age'),
    body('heightCm').optional().isFloat({ min: 0 }).withMessage('Enter a valid height'),
    body('weightKg').optional().isFloat({ min: 0 }).withMessage('Enter a valid weight'),
    body('address').optional().isString().trim(),
    // checkFalsy: true lets an empty string through validation-free — that's
    // how "Disconnect" clears the link. Anything non-empty must be a real URL.
    body('facebookUrl')
      .optional({ checkFalsy: true })
      .trim()
      .isURL()
      .withMessage('Enter a valid Facebook URL'),
    body('instagramUrl')
      .optional({ checkFalsy: true })
      .trim()
      .isURL()
      .withMessage('Enter a valid Instagram URL'),
    // Free-text medical fields — length-capped to keep this a quick
    // reference for an instructor, not a place to paste a full medical
    // history document.
    body('medicalConditions').optional({ checkFalsy: true }).isString().trim().isLength({ max: 1000 }),
    body('medicalAllergies').optional({ checkFalsy: true }).isString().trim().isLength({ max: 500 }),
    body('emergencyContactName').optional({ checkFalsy: true }).isString().trim().isLength({ max: 200 }),
    body('emergencyContactPhone').optional({ checkFalsy: true }).isString().trim().isLength({ max: 50 }),
    body('medicalNotes').optional({ checkFalsy: true }).isString().trim().isLength({ max: 1000 }),
    body('medicalConsent').optional().isBoolean(),
  ],
  userController.updateProfile
);
// Upload or replace profile photo
router.put('/profile/photo', upload.single('photo'), userController.uploadProfilePhoto);
router.get('/profile/social', userController.getSocialAccounts);
router.put(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    body('confirmPassword').notEmpty().withMessage('Confirm password is required').custom((value, { req }) => value === req.body.newPassword).withMessage('Passwords do not match'),
  ],
  userController.changePassword
);
router.get('/subscriptions', userController.getSubscriptions);
router.get('/dashboard-summary', userController.getDashboardSummary);

module.exports = router;