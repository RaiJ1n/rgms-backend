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
// Upload/replace, view, and remove the medical document (certificate,
// clearance, doctor's note). Uses the separate, secured uploader from
// uploadMiddleware.js — see that file for why this isn't just `upload`.
router.put(
  '/profile/medical-document',
  (req, res, next) => {
    upload.uploadMedicalDocument.single('medicalDocument')(req, res, (err) => {
      if (err) {
        // multer errors (bad file type from fileFilter, file too large) land
        // here rather than in the route handler, since multer itself calls
        // next(err) before req even reaches userController.
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'File is too large. Maximum size is 5MB.'
            : err.message || 'Could not upload file.';
        return res.status(400).json({ success: false, message });
      }
      next();
    });
  },
  userController.uploadMedicalDocument
);
router.get('/profile/medical-document', userController.viewMedicalDocument);
router.delete('/profile/medical-document', userController.deleteMedicalDocument);
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