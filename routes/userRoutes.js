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