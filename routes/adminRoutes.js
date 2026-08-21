const express = require('express');
const { body } = require('express-validator');
const adminController = require('../controllers/adminController');
const userController = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

router.use(protect, admin);
router.get('/users', adminController.getUsers);

router.get('/members', adminController.getMembers);
router.post(
  '/members',
  [
    body('fullname').notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('phone').optional().isMobilePhone().withMessage('Enter a valid mobile number'),
    body('address').optional().isString().trim(),
  ],
  adminController.createMember
);
router.get('/members/:id', adminController.getMember);
router.put(
  '/members/:id',
  [
    body('fullname').optional().notEmpty(),
    body('phone').optional().isMobilePhone().withMessage('Enter a valid mobile number'),
    body('address').optional().isString().trim(),
    body('email').optional().isEmail().withMessage('Enter a valid email').normalizeEmail(),
    // Same length caps as userRoutes.js's member-facing validators —
    // this is the admin-side path to the same fields.
    body('medicalConditions').optional({ checkFalsy: true }).isString().trim().isLength({ max: 1000 }),
    body('medicalAllergies').optional({ checkFalsy: true }).isString().trim().isLength({ max: 500 }),
    body('emergencyContactName').optional({ checkFalsy: true }).isString().trim().isLength({ max: 200 }),
    body('emergencyContactPhone').optional({ checkFalsy: true }).isString().trim().isLength({ max: 50 }),
    body('medicalNotes').optional({ checkFalsy: true }).isString().trim().isLength({ max: 1000 }),
  ],
  adminController.updateMember
);
router.put(
  '/members/:id/status',
  [body('isActive').isBoolean().withMessage('isActive must be true or false')],
  adminController.setMemberStatus
);
router.put(
  '/members/:id/student-promo',
  [body('studentPromoActive').isBoolean().withMessage('studentPromoActive must be true or false')],
  adminController.setStudentPromoActive
);
router.delete('/members/:id', adminController.deleteMember);

router.get('/notifications', adminController.getNotifications);
router.put('/notifications/:id/read', adminController.markNotificationRead);
router.put('/notifications/mark-all-read', adminController.markAllNotificationsRead);

router.get('/payments', adminController.getPayments);
router.post(
  '/payments/manual',
  [
    body('userId').isMongoId().withMessage('A member must be selected'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('planId').isMongoId().withMessage('A membership plan must be selected'),
    body('paymentMethod').optional().isString().trim(),
    body('referenceNumber').optional().isString().trim(),
  ],
  adminController.createManualPayment
);
router.put('/payments/:id/approve', adminController.approvePayment);
router.put('/payments/:id/reject', adminController.rejectPayment);

router.get('/subscriptions', adminController.getSubscriptions);
router.post(
  '/plans',
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('duration').notEmpty().withMessage('Duration is required'),
    body('price').isNumeric().withMessage('Price must be a number'),
  ],
  adminController.createPlan
);
router.put('/plans/:id', adminController.updatePlan);
router.delete('/plans/:id', adminController.deletePlan);

router.post(
  '/attendance/manual',
  [
    body('userId').optional().isMongoId().withMessage('Invalid member selected'),
    body('guestName').optional().isString().trim().notEmpty().withMessage('Enter a name'),
    body('memberType').optional().isIn(['Regular', 'Student']).withMessage('Type must be Regular or Student'),
    body('notes').optional().isString().trim(),
  ],
  adminController.createManualAttendance
);

router.get('/student-ids', adminController.getStudentIdSubmissions);
router.put('/student-ids/:id/approve', adminController.approveStudentId);
router.put(
  '/student-ids/:id/reject',
  [body('reason').optional().isString().trim()],
  adminController.rejectStudentId
);

router.post('/security/send-otp', adminController.sendPasswordChangeOtp);
router.put(
  '/security/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    body('otp').notEmpty().withMessage('Verification code is required'),
  ],
  adminController.changePassword
);

router.get('/profile', userController.getProfile);
router.put(
  '/profile',
  [
    body('fullname').notEmpty().withMessage('Full name is required'),
    body('email').optional().isEmail().withMessage('Enter a valid email').normalizeEmail(),
  ],
  userController.updateProfile
);
router.put('/profile/photo', upload.single('photo'), userController.uploadProfilePhoto);

module.exports = router;