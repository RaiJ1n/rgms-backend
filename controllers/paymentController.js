const Payment = require('../models/Payment');
const MembershipPlan = require('../models/MembershipPlan');
const emailService = require('../services/emailService');

const httpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const submitPayment = async (req, res, next) => {
  try {
    const { referenceNumber, paymentMethod, planId } = req.body;
    const screenshot = req.file ? req.file.path : undefined;

    // Reject a reference number that's already been submitted (pending,
    // approved, or rejected) under the same payment method — prevents a
    // single real transaction being used to spin up multiple Payment
    // records, which an admin could accidentally approve more than once.
    const existing = await Payment.findOne({ referenceNumber, paymentMethod });
    if (existing) {
      throw httpError('This reference number has already been submitted', 400);
    }

    let amount = req.body.amount;
    if (planId) {
      const plan = await MembershipPlan.findById(planId);
      if (!plan) throw httpError('Plan not found', 404);
      amount = req.user.studentPromoActive && plan.studentPrice ? plan.studentPrice : plan.price;
    } else if (!amount) {
      throw httpError('Amount is required when no plan is specified', 400);
    }

    const payment = await Payment.create({
      userId: req.user._id,
      planId: planId || undefined,
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