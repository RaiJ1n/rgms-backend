const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');
const Payment = require('../models/Payment');
const socketUtil = require('../utils/socket');
const { formatLocalDateLabel } = require('../utils/localDate');

// durationValue/durationUnit replace the old string-matched `duration` field
// Any plan an admin creates from now on — including one-off plans like a "Student Plan"
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

const httpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Calendar math in the gym's own timezone (Asia/Manila, UTC+8, no DST) — never the server's
// An extension starts exactly where the previous window ends, so windows touch but never overlap
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const addDuration = (date, value, unit) => {
  const shifted = new Date(new Date(date).getTime() + MANILA_OFFSET_MS);
  switch (unit) {
    case 'day':
      shifted.setUTCDate(shifted.getUTCDate() + value);
      break;
    case 'week':
      shifted.setUTCDate(shifted.getUTCDate() + value * 7);
      break;
    case 'month':
    case 'year': {
      const months = unit === 'year' ? value * 12 : value;
      const day = shifted.getUTCDate();
      shifted.setUTCDate(1);
      shifted.setUTCMonth(shifted.getUTCMonth() + months);
      const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
      shifted.setUTCDate(Math.min(day, lastDay));
      break;
    }
    default:
      // Should be unreachable
      throw httpError(`Unsupported duration unit: ${unit}`, 400);
  }
  return new Date(shifted.getTime() - MANILA_OFFSET_MS);
};

// The user's currently-effective expiration
const getExpiryBaseDate = async (userId) => {
  const latest = await Subscription.findOne({ userId }).sort({ endDate: -1 });
  const now = new Date();
  if (latest && latest.endDate > now) {
    return latest.endDate;
  }
  return now;
};

// Two approvals for the same member landing at the same moment would both read the same "latest
// 
const userLocks = new Map();
const withUserLock = async (userId, fn) => {
  const key = String(userId);
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const tail = prev.then(() => gate);
  userLocks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(key) === tail) userLocks.delete(key);
  }
};

// The member's continuous coverage right now
const getCoverageWindow = (rows, now = new Date()) => {
  if (!rows || !rows.length) return null;
  const live = rows.filter((r) => r.endDate > now);
  const pool = live.length ? live : [rows.slice().sort((a, b) => b.endDate - a.endDate)[0]];
  const start = new Date(Math.min(...pool.map((r) => r.startDate.getTime())));
  const end = new Date(Math.max(...pool.map((r) => r.endDate.getTime())));
  return { startDate: start, endDate: end };
};

const createSubscriptionUnlocked = async ({ userId, planId, paymentId }) => {
  const plan = await MembershipPlan.findById(planId);
  if (!plan) {
    throw httpError('Plan not found', 404);
  }
  if (!plan.durationValue || !plan.durationUnit) {
    // Plan predates the durationValue/durationUnit fields, or was created without them
    // Fail clearly instead of guessing at an expiration
    throw httpError('This plan is missing a configured duration. Please update it in Admin Settings before it can be purchased.', 400);
  }

  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw httpError('Payment not found', 404);
  }
  if (!payment.userId) {
    throw httpError('This payment is not linked to a member account', 400);
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

  // Extend from the user's current effective expiration instead of always starting from now
  // Extend from the user's current effective expiration instead of always starting from now — this is the actual fix
  const baseDate = await getExpiryBaseDate(userId);
  const startDate = baseDate;
  const endDate = addDuration(baseDate, plan.durationValue, plan.durationUnit);

  let subscription;
  try {
    subscription = await Subscription.create({
      userId,
      planId,
      paymentId,
      startDate,
      endDate,
      status: 'active',
    });
  } catch (err) {
    // Belt-and-suspenders for the findOne check above
    if (err.code === 11000) {
      throw httpError('A subscription already exists for this payment', 400);
    }
    throw err;
  }

  // Single choke point for every subscription creation
  socketUtil.emitToAdmins('stats:refresh');
  socketUtil.emitToUser(userId, 'subscription:updated', subscription);

  return subscription;
};

const createSubscription = (args) => withUserLock(args.userId, () => createSubscriptionUnlocked(args));

const getMySubscription = async (userId) => {
  return Subscription.findOne({ userId }).sort({ endDate: -1 }).populate('planId');
};

// A plan grants unlimited-looking access for exactly 1 day (durationValue 1 / durationUnit 'day')
// It's identified by its actual duration, not by name
const isDayPassPlan = (plan) => plan?.durationValue === 1 && plan?.durationUnit === 'day';

// Deducts one membership/session from the member's current subscription - AT MOST ONCE PER MANILA DAY
// Deducts one membership/session from the member's current subscription - AT MOST ONCE PER MANILA DAY, atomically
const recordAttendanceSession = async (userId, opts = {}) => {
  const dayKey = opts.dayKey || formatLocalDateLabel(new Date());
  const firstOfDay = opts.firstOfDay !== false;

  const subscription = await Subscription.findOne({ userId }).sort({ endDate: -1 }).populate('planId');
  if (!subscription) return { deducted: false, reason: 'no_subscription' };
  if (isDayPassPlan(subscription.planId)) return { deducted: false, reason: 'day_pass', subscription };

  const filter = { _id: subscription._id, lastDeductedDayKey: { $ne: dayKey } };
  if (!firstOfDay) {
    filter.$or = [
      { lastDeductedDayKey: { $exists: true } },
      { sessionsUsed: { $exists: false } },
      { sessionsUsed: { $lte: 0 } },
    ];
  }
  const updated = await Subscription.findOneAndUpdate(
    filter,
    { $inc: { sessionsUsed: 1 }, $set: { lastDeductedDayKey: dayKey } },
    { new: true },
  );
  if (updated) return { deducted: true, reason: 'deducted', subscription: updated };

  // Nothing matched
  const current = await Subscription.findById(subscription._id).select('lastDeductedDayKey sessionsUsed');
  if (!current) {
    console.error('[SUBSCRIPTION] deduction skipped: subscription disappeared', { userId: String(userId), subscriptionId: String(subscription._id) });
    return { deducted: false, reason: 'subscription_missing' };
  }
  if (current.lastDeductedDayKey === dayKey) return { deducted: false, reason: 'already_deducted' };
  if (!firstOfDay && (current.lastDeductedDayKey === undefined || current.lastDeductedDayKey === null)) {
    return { deducted: false, reason: 'legacy_assumed_deducted' };
  }
  console.error('[SUBSCRIPTION] deduction matched nothing for an unexpected reason', { userId: String(userId), subscriptionId: String(subscription._id), dayKey, marker: current.lastDeductedDayKey });
  return { deducted: false, reason: 'unexpected_no_match' };
};

module.exports = {
   getAllPlans, 
   createSubscription, 
   getMySubscription, 
   recordAttendanceSession, 
   isDayPassPlan, 
   getCoverageWindow, 
   addDuration 
  };