const express = require('express');
const { body } = require('express-validator');
const adminController = require('../controllers/adminController');
const { protect } = require('../middleware/authMiddleware');
const { admin } = require('../middleware/adminMiddleware');

const router = express.Router();

router.use(protect, admin);
router.get('/users', adminController.getUsers);
router.get('/payments', adminController.getPayments);
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

module.exports = router;
