const express = require('express');
const { body } = require('express-validator');
const userController = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/profile', userController.getProfile);
router.put(
  '/profile',
  [
    body('fullname').optional().notEmpty(),
    body('phone').optional().isMobilePhone(),
    body('address').optional().isString().trim(),
    body('age').optional().isInt({ min: 0, max: 120 }).withMessage('Age must be between 0 and 120'),
    body('heightCm').optional().isFloat({ min: 0 }).withMessage('Height must be a positive number'),
    body('weightKg').optional().isFloat({ min: 0 }).withMessage('Weight must be a positive number'),
    body('calorieGoal').optional().isInt({ min: 0 }).withMessage('Calorie goal must be a positive number'),
    body('birthDate').optional().isISO8601().withMessage('Enter a valid date'),
    body('email').optional().isEmail().withMessage('Enter a valid email').normalizeEmail(),
  ],
  userController.updateProfile
);
router.put(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  ],
  userController.changePassword
);
router.get('/subscriptions', userController.getSubscriptions);
router.get('/dashboard-summary', userController.getDashboardSummary);

module.exports = router;