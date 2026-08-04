const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const classCtrl = require('../controllers/classController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');
const upload = require('../middleware/uploadMiddleware');

const STATUS_VALUES = ['Active', 'Cancelled', 'Completed'];

// Browsing the class schedule is public. Only open (Active, upcoming)
// classes come back here — see classController.getClasses.
router.get('/', classCtrl.getClasses);

// Admin management list — every class regardless of status/date.
// Registered before '/:id' so 'admin' is never mistaken for an id.
router.get('/admin/all', protect, admin, classCtrl.getAllClassesAdmin);

router.get('/:id', classCtrl.getClass);

// Creating/editing/removing classes is admin-only. 'image' is optional —
// multer/Cloudinary only sets req.file when a file is actually sent, so
// editing a class without touching its photo works the same as before.
// Validators run after upload.single() on purpose — multer is what
// parses the multipart body into req.body, so express-validator has
// nothing to check against if it runs first.
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
    body('fee').optional().isFloat({ min: 0 }).withMessage('Fee cannot be negative'),
    body('status').optional().isIn(STATUS_VALUES).withMessage('Invalid status'),
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
    body('fee').optional().isFloat({ min: 0 }).withMessage('Fee cannot be negative'),
    body('status').optional().isIn(STATUS_VALUES).withMessage('Invalid status'),
  ],
  classCtrl.updateClass
);
router.delete('/:id', protect, admin, classCtrl.deleteClass);

// Any logged-in member can register/cancel for themselves.
router.post('/:id/register', protect, classCtrl.registerMember);
router.post('/:id/cancel', protect, classCtrl.cancelRegistration);

module.exports = router;