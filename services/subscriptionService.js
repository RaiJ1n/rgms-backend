const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');
const Payment = require('../models/Payment');
const socketUtil = require('../utils/socket');

const defaultPlans = [
  { name: 'Daily', duration: 'Daily Pass', price: 120, studentPrice: 100, description: '1 day access to gym' },
  { name: 'Weekly', duration: 'Weekly Pass', price: 800, studentPrice: 700, description: '7 days access to gym' },
  { name: 'Monthly', duration: 'Monthly Membership', price: 3000, studentPrice: 2500, description: '30 days access to gym' },
  { name: 'Yearly', duration: 'Annual Membership', price: 30000, studentPrice: 25000, description: '365 days access to gym' },
];

const ensureDefaultPlans = async () => {
  const count = await MembershipPlan.countDocuments();
  if (count === 0) {
    await MembershipPlan.insertMany(defaultPlans);
  }
};

const getAllPlans = async () => {
  const plans = await MembershipPlan.find();
  if (plans.length === 0) {
    await ensureDefaultPlans();
    return MembershipPlan.find();
  }
  return plans;
};

// Small helper so service-layer errors carry the right HTTP status instead
// of falling through errorMiddleware as a generic 500.
const httpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const createSubscription = async ({ userId, planId, paymentId }) => {
  const plan = await MembershipPlan.findById(planId);
  if (!plan) {
    throw httpError('Plan not found', 404);
  }

  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw httpError('Payment not found', 404);
  }
  if (payment.userId.toString() !== userId.toString()) {
    throw httpError('Payment does not belong to this user', 403);
  }
  if (payment.status !== 'approved') {
    throw httpError('Payment has not been approved yet', 400);
  }

  const existing = await Subscription.findOne({ paymentId });
  if (existing) {
    throw httpError('A subscription already exists for this payment', 400);
  }

  const startDate = new Date();
  let endDate = new Date(startDate);

  switch (plan.duration.toLowerCase()) {
    case 'daily pass':
      endDate.setDate(endDate.getDate() + 1);
      break;
    case 'weekly pass':
      endDate.setDate(endDate.getDate() + 7);
      break;
    case 'monthly membership':
      endDate.setMonth(endDate.getMonth() + 1);
      break;
    case 'annual membership':
      endDate.setFullYear(endDate.getFullYear() + 1);
      break;
    default:
      throw httpError('Invalid plan duration', 400);
  }

  const subscription = await Subscription.create({
    userId,
    planId,
    paymentId,
    startDate,
    endDate,
    status: 'active',
  });

  // Single choke point for every subscription creation (member
  // self-checkout and admin payment-approval both land here), so this is
  // the one place that needs to say "membership counts changed."
  socketUtil.emitToAdmins('stats:refresh');
  socketUtil.emitToUser(userId, 'subscription:updated', subscription);

  return subscription;
};

const getMySubscription = async (userId) => {
  return Subscription.findOne({ userId }).populate('planId');
};

module.exports = { getAllPlans, createSubscription, getMySubscription };