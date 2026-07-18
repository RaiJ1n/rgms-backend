const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');

const getAllPlans = async () => {
  return MembershipPlan.find();
};

const createSubscription = async ({ userId, planId, paymentId }) => {
  const plan = await MembershipPlan.findById(planId);
  if (!plan) {
    throw new Error('Plan not found');
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
      throw new Error('Invalid plan duration');
  }

  return Subscription.create({
    userId,
    planId,
    paymentId,
    startDate,
    endDate,
    status: 'active',
  });
};

const getMySubscription = async (userId) => {
  return Subscription.findOne({ userId }).populate('planId');
};

module.exports = { getAllPlans, createSubscription, getMySubscription };
