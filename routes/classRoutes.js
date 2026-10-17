const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const classCtrl = require('../controllers/classController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const upload = require('../middleware/uploadMiddleware');

const STATUS_VALUES = ['Active', 'Cancelled', 'Completed'];

// Browsing the class schedule is public
router.get('/', classCtrl.getClasses);

// Admin management list
router.get('/admin/all', protect, admin, classCtrl.getAllClassesAdmin);

// Registered members for the admin "View" modal
router.get('/:id/members', protect, admin, classCtrl.getClassMembers);

router.get('/:id', classCtrl.getClass);

// Creating/editing/removing classes is admin-only
router.post(
  '/',
  protect,
  admin,
  upload.single('image'),
  [
    body('name').notEmpty().withMessage('Class name is required'),
    body('date').notEmpty().withMessage('Date is required').isISO8601().withMessage('Enter a valid date'),
    body('startTime').notEmpty().withMessage('Start time is required'),
    body('endTime').notEmpty().withMessage('End time is required'),
    body('capacity').optional().isInt({ min: 1 }).withMessage('Capacity must be at least 1'),
    body('status').optional().isIn(STATUS_VALUES).withMessage('Invalid status'),
    body('instructorId').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid instructor selected'),
  ],
  classCtrl.createClass
);
router.put(
  '/:id',
  protect,
  admin,
  upload.single('image'),
  [
    body('name').optional().notEmpty().withMessage('Class name cannot be empty'),
    body('date').optional().isISO8601().withMessage('Enter a valid date'),
    body('capacity').optional().isInt({ min: 1 }).withMessage('Capacity must be at least 1'),
    body('status').optional().isIn(STATUS_VALUES).withMessage('Invalid status'),
    body('instructorId').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid instructor selected'),
  ],
  classCtrl.updateClass
);
router.delete('/:id', protect, admin, classCtrl.deleteClass);

// Any logged-in member can register/cancel for themselves
router.post('/:id/register', protect, classCtrl.registerMember);
router.post('/:id/cancel', protect, classCtrl.cancelRegistration);

module.exports = router;