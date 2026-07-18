const express = require('express');
const { body } = require('express-validator');
const paymentController = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

router.post(
  '/submit',
  protect,
  upload.single('screenshot'),
  [
    body('referenceNumber').notEmpty().withMessage('Reference number is required'),
    body('amount').isNumeric().withMessage('Amount is required'),
  ],
  paymentController.submitPayment
);
router.get('/history', protect, paymentController.getPaymentHistory);

module.exports = router;
