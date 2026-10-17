const express = require('express');
const { body } = require('express-validator');
const userController = require('../controllers/userController');
const workoutPlanController = require('../controllers/workoutPlanController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

router.use(protect);
router.get('/profile', userController.getProfile);
router.put('/privacy-notice/acknowledge', userController.acknowledgePrivacyNotice);
router.put(
  '/profile',
  [
    body('fullname').trim().notEmpty().withMessage('Full name is required'),
    body('email').optional().trim().isEmail().withMessage('Enter a valid email').normalizeEmail(),
    body('age').optional().isInt({ min: 0, max: 120 }).withMessage('Enter a valid age'),
    body('heightCm').optional().isFloat({ min: 0 }).withMessage('Enter a valid height'),
    body('weightKg').optional().isFloat({ min: 0 }).withMessage('Enter a valid weight'),
    body('sex').optional({ checkFalsy: true }).isIn(['Male', 'Female', 'Other']).withMessage('Invalid sex value'),
    body('calorieGoal').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Enter a valid calorie goal'),
    body('address').optional().isString().trim(),
    // checkFalsy
    // Anything non-empty must be a real URL
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
    // Free-text medical fields
    body('medicalConditions').optional({ checkFalsy: true }).isString().trim().isLength({ max: 1000 }),
    body('medicalAllergies').optional({ checkFalsy: true }).isString().trim().isLength({ max: 500 }),
    body('emergencyContactName').optional({ checkFalsy: true }).isString().trim().isLength({ max: 200 }),
    body('emergencyContactPhone').optional({ checkFalsy: true }).isString().trim().isLength({ max: 50 }),
    body('medicalNotes').optional({ checkFalsy: true }).isString().trim().isLength({ max: 1000 }),
    body('medicalConsent').optional().isBoolean(),
    body('privacyNoticeAcknowledged').optional().isBoolean(),
  ],
  userController.updateProfile
);
// Upload or replace profile photo
router.put('/profile/photo', upload.single('photo'), userController.uploadProfilePhoto);
// Upload/replace, view, and remove medical documents (certificates, clearances, doctor's notes)
// Uses the separate, secured uploader from uploadMiddleware.js — see that file for why this isn't just `upload`
router.put(
  '/profile/medical-document',
  (req, res, next) => {
    upload.uploadMedicalDocument.array('medicalDocuments', upload.MEDICAL_DOCUMENT_MAX_FILES)(req, res, (err) => {
      if (err) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'One of the files is too large. Maximum size is 2MB per file.'
            : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? `You can upload up to ${upload.MEDICAL_DOCUMENT_MAX_FILES} files at a time.`
            : err.message || 'Could not upload file.';
        return res.status(400).json({ success: false, message });
      }
      next();
    });
  },
  userController.uploadMedicalDocument
);
router.get('/profile/medical-document/:docId', userController.viewMedicalDocument);
router.delete('/profile/medical-document/:docId', userController.deleteMedicalDocument);
router.get('/profile/social', userController.getSocialAccounts);
router.post('/security/send-otp', userController.sendPasswordChangeOtp);
router.put(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    body('confirmPassword').notEmpty().withMessage('Confirm password is required').custom((value, { req }) => value === req.body.newPassword).withMessage('Passwords do not match'),
    body('otp').notEmpty().withMessage('Verification code is required'),
  ],
  userController.changePassword
);
router.get('/subscriptions', userController.getSubscriptions);
router.get('/dashboard-summary', userController.getDashboardSummary);
// Every attendance session of the signed-in member (paginated, sortable)
router.get('/attendance', userController.getAttendanceHistory);

// Assigned workout plans (member side of Sections E4/E5) getMyAssignedPlans/getMyAssignedPlanDetail
router.get('/workout-plans', workoutPlanController.getMyAssignedPlans);
router.get('/workout-plans/:id', workoutPlanController.getMyAssignedPlanDetail);
router.put(
  '/workout-plans/:id/progress',
  [
    body('componentId').isMongoId().withMessage('Invalid exercise'),
    body('completedSets').isArray().withMessage('completedSets must be a list'),
    body('completedSets.*').isInt({ min: 1 }).withMessage('Invalid set number'),
    body('notes').optional().isString().trim().isLength({ max: 500 }),
  ],
  workoutPlanController.updateProgress
);
router.post('/workout-plans/:id/new-day', workoutPlanController.resetDailyProgress);

module.exports = router;