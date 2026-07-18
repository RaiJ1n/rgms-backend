const subscriptionService = require('../services/subscriptionService');
const MembershipPlan = require('../models/MembershipPlan');

const getPlans = async (req, res, next) => {
  try {
    const plans = await subscriptionService.getAllPlans();
    res.json({ success: true, data: plans });
  } catch (error) {
    next(error);
  }
};

const createSubscription = async (req, res, next) => {
  try {
    const { planId, paymentId } = req.body;
    const subscription = await subscriptionService.createSubscription({
      userId: req.user._id,
      planId,
      paymentId,
    });
    res.status(201).json({ success: true, message: 'Subscription created', data: subscription });
  } catch (error) {
    next(error);
  }
};

const getMySubscription = async (req, res, next) => {
  try {
    const subscription = await subscriptionService.getMySubscription(req.user._id);
    res.json({ success: true, data: subscription });
  } catch (error) {
    next(error);
  }
};

module.exports = { getPlans, createSubscription, getMySubscription };
