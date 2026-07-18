const express = require('express');
const { body } = require('express-validator');
const subscriptionController = require('../controllers/subscriptionController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/plans', subscriptionController.getPlans);
router.post(
  '/create',
  protect,
  [body('planId').notEmpty().withMessage('Plan ID is required'), body('paymentId').notEmpty().withMessage('Payment ID is required')],
  subscriptionController.createSubscription
);
router.get('/my-subscription', protect, subscriptionController.getMySubscription);

module.exports = router;
