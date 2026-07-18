const Payment = require('../models/Payment');
const emailService = require('../services/emailService');

const submitPayment = async (req, res, next) => {
  try {
    const { referenceNumber, paymentMethod, amount } = req.body;
    const screenshot = req.file ? req.file.path : undefined;

    const payment = await Payment.create({
      userId: req.user._id,
      referenceNumber,
      paymentMethod,
      amount,
      screenshot,
      status: 'pending',
    });

    res.status(201).json({ success: true, message: 'Payment submitted', data: payment });
  } catch (error) {
    next(error);
  }
};

const getPaymentHistory = async (req, res, next) => {
  try {
    const payments = await Payment.find({ userId: req.user._id });
    res.json({ success: true, data: payments });
  } catch (error) {
    next(error);
  }
};

module.exports = { submitPayment, getPaymentHistory };
