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

// The user's currently-effective expiration, independent of how many
// Subscription rows they've accumulated across past purchases and
// independent of each row's stored `status` (nothing in this codebase
// flips status from 'active' to 'expired' as time passes, so status
// alone can't be trusted to answer "is this still active right now").
//
// We just take the latest endDate the user has ever been granted:
//   - if it's still in the future, that's the base to extend from
//   - if it's in the past (or there's no subscription at all), the new
//     membership starts fresh from now
const getExpiryBaseDate = async (userId) => {
  const latest = await Subscription.findOne({ userId }).sort({ endDate: -1 });
  const now = new Date();
  if (latest && latest.endDate > now) {
    return latest.endDate;
  }
  return now;
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

  // Extend from the user's current effective expiration instead of
  // always starting from now — this is the actual fix. If they have no
  // subscription yet, or their latest one has already lapsed,
  // getExpiryBaseDate() falls back to `now` on its own (requirement 5).
  const baseDate = await getExpiryBaseDate(userId);
  const startDate = new Date();
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
    // Belt-and-suspenders for the findOne check above: if two requests
    // for the same payment race each other, the unique index on
    // paymentId (see models/Subscription.js) rejects the loser here
    // instead of silently granting a second extension.
    if (err.code === 11000) {
      throw httpError('A subscription already exists for this payment', 400);
    }
    throw err;
  }

  // Single choke point for every subscription creation (member
  // self-checkout and admin payment-approval both land here), so this is
  // the one place that needs to say "membership counts changed."
  socketUtil.emitToAdmins('stats:refresh');
  socketUtil.emitToUser(userId, 'subscription:updated', subscription);

  return subscription;
};

const getMySubscription = async (userId) => {
  // The currently-controlling subscription is whichever row has the
  // furthest-out endDate — same reasoning as getExpiryBaseDate above.
  // Previously this was an unsorted findOne, which could return an old,
  // already-superseded row once a user had purchased more than once.
  return Subscription.findOne({ userId }).sort({ endDate: -1 }).populate('planId');
};

// A plan grants unlimited-looking access for exactly 1 day (durationValue
// 1 / durationUnit 'day') — the "Daily"/Day Pass plan seeded above. It's
// identified by its actual duration, not by name, so an admin renaming
// the plan later doesn't silently break this check.
const isDayPassPlan = (plan) => plan?.durationValue === 1 && plan?.durationUnit === 'day';

// Deducts one membership/session from the member's current subscription.
// Called from exactly two places, per the spec: attendanceService.js's
// processMemberScan (an RFID tap that opens a NEW attendance record —
// i.e. a check-in, not a check-out) and adminController.js's
// createManualAttendance (an admin manually adding a member to
// attendance). A Day Pass plan is deliberately left untouched — nothing
// to track for a single-visit pass. Silently no-ops (rather than
// throwing) if the member has no subscription at all, since callers of
// this are logging attendance either way and a missing/lapsed
// subscription shouldn't block that — same "attendance still gets
// recorded" behavior createManualAttendance already had before session
// tracking existed.
const recordAttendanceSession = async (userId) => {
  const subscription = await Subscription.findOne({ userId }).sort({ endDate: -1 }).populate('planId');
  if (!subscription) return null;
  if (isDayPassPlan(subscription.planId)) return subscription;

  subscription.sessionsUsed = (subscription.sessionsUsed || 0) + 1;
  await subscription.save();
  return subscription;
};

module.exports = { getAllPlans, createSubscription, getMySubscription, recordAttendanceSession, isDayPassPlan };