const User = require('../models/User');
const Payment = require('../models/Payment');
const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');
const emailService = require('../services/emailService');

const getUsers = async (req, res) => {
  console.log(req.user.email);
  try {
    const getAllUsers = await User.find()
      .populate('client')
      .exec();

    if (getAllUsers.length == 0) {
      return res.sendStatus(204);
    }
    res.status(200).json({
      message: 'This is all users',
      content: getAllUsers,
    });
  } catch (err) {
    res.status(400).json({
      content: err,
    });
  }
};

const getPayments = async (req, res, next) => {
  try {
    const payments = await Payment.find().populate('userId', 'fullname email');
    res.json({ success: true, data: payments });
  } catch (error) {
    next(error);
  }
};

const approvePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });

    payment.status = 'approved';
    await payment.save();
    await emailService.sendPaymentStatusEmail(await User.findById(payment.userId), payment);

    res.json({ success: true, message: 'Payment approved', data: payment });
  } catch (error) {
    next(error);
  }
};

const rejectPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });

    payment.status = 'rejected';
    await payment.save();
    await emailService.sendPaymentStatusEmail(await User.findById(payment.userId), payment);

    res.json({ success: true, message: 'Payment rejected', data: payment });
  } catch (error) {
    next(error);
  }
};

const getSubscriptions = async (req, res, next) => {
  try {
    const subscriptions = await Subscription.find().populate('planId').populate('userId', 'fullname email');
    res.json({ success: true, data: subscriptions });
  } catch (error) {
    next(error);
  }
};

const createPlan = async (req, res, next) => {
  try {
    const plan = await MembershipPlan.create(req.body);
    res.status(201).json({ success: true, message: 'Plan created', data: plan });
  } catch (error) {
    next(error);
  }
};

const updatePlan = async (req, res, next) => {
  try {
    const plan = await MembershipPlan.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: 'Plan updated', data: plan });
  } catch (error) {
    next(error);
  }
};

const deletePlan = async (req, res, next) => {
  try {
    const plan = await MembershipPlan.findByIdAndDelete(req.params.id);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, message: 'Plan deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  getPayments,
  approvePayment,
  rejectPayment,
  getSubscriptions,
  createPlan,
  updatePlan,
  deletePlan,
};
