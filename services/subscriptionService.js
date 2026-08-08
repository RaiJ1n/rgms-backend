const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');
const Payment = require('../models/Payment');
const socketUtil = require('../utils/socket');

// durationValue/durationUnit replace the old string-matched `duration`
// field ("Daily Pass", "Annual Membership", ...) for date math. Any plan
// an admin creates from now on — including one-off plans like a
// "Student Plan" — expires correctly automatically, with no code change
// needed here, as long as it has these two fields set.
const defaultPlans = [
  { name: 'Daily', duration: 'Daily Pass', durationValue: 1, durationUnit: 'day', price: 120, studentPrice: 100, description: '1 day access to gym' },
  { name: 'Weekly', duration: 'Weekly Pass', durationValue: 7, durationUnit: 'day', price: 800, studentPrice: 700, description: '7 days access to gym' },
  { name: 'Monthly', duration: 'Monthly Membership', durationValue: 1, durationUnit: 'month', price: 3000, studentPrice: 2500, description: '30 days access to gym' },
  { name: 'Yearly', duration: 'Annual Membership', durationValue: 1, durationUnit: 'year', price: 30000, studentPrice: 25000, description: '365 days access to gym' },
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

// Generic replacement for the old switch(plan.duration.toLowerCase()){...}.
// Works for any plan, present or future, as long as it has durationValue
// (Number) and durationUnit ('day' | 'week' | 'month' | 'year') set.
const addDuration = (date, value, unit) => {
  const result = new Date(date);
  switch (unit) {
    case 'day':
      result.setDate(result.getDate() + value);
      break;
    case 'week':
      result.setDate(result.getDate() + value * 7);
      break;
    case 'month':
      result.setMonth(result.getMonth() + value);
      break;
    case 'year':
      result.setFullYear(result.getFullYear() + value);
      break;
    default:
      // Should be unreachable — durationUnit is schema-enforced — but
      // fail loudly rather than silently producing a wrong date if the
      // schema and this list ever drift apart.
      throw httpError(`Unsupported duration unit: ${unit}`, 400);
  }
  return result;
};

const createSubscription = async ({ userId, planId, paymentId }) => {
  const plan = await MembershipPlan.findById(planId);
  if (!plan) {
    throw httpError('Plan not found', 404);
  }
  if (!plan.durationValue || !plan.durationUnit) {
    // Plan predates the durationValue/durationUnit fields, or was created
    // without them. Fail clearly instead of guessing at an expiration.
    throw httpError('This plan is missing a configured duration. Please update it in Admin Settings before it can be purchased.', 400);
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
  const endDate = addDuration(startDate, plan.durationValue, plan.durationUnit);

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