const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { startOfLocalDay, endOfLocalDay, startOfLocalWeek, startOfLocalMonth, startOfLocalYear } = require('../utils/localDate');

// Helper to parse date range
function parseRange(q) {
  const { startDate, endDate } = q;
  const match = {};
  if (startDate || endDate) match.createdAt = {};
  if (startDate) match.createdAt.$gte = new Date(startDate);
  if (endDate) match.createdAt.$lte = new Date(endDate);
  return match;
}

const getNewVsRenewalCounts = async (match) => {
  const activeSubsInRange = await Subscription.find({ ...match, status: 'active' })
    .select('userId createdAt')
    .lean();

  if (!activeSubsInRange.length) {
    return { newMemberships: 0, renewals: 0 };
  }

  const userIds = [...new Set(activeSubsInRange.map((s) => s.userId.toString()))];

  const firstSubs = await Subscription.aggregate([
    { $match: { userId: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: '$userId', firstSubId: { $first: '$_id' } } },
  ]);
  const firstSubIdByUser = new Map(firstSubs.map((f) => [f._id.toString(), f.firstSubId.toString()]));

  let newMemberships = 0;
  let renewals = 0;
  for (const sub of activeSubsInRange) {
    const isFirstEver = firstSubIdByUser.get(sub.userId.toString()) === sub._id.toString();
    if (isFirstEver) newMemberships += 1;
    else renewals += 1;
  }

  return { newMemberships, renewals };
};

exports.summary = async (req, res, next) => {
  try {
    const match = parseRange(req.query);
    const payments = await Payment.aggregate([
      { $match: { ...match, status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const totalRevenue = payments[0] ? payments[0].total : 0;
    const { newMemberships, renewals } = await getNewVsRenewalCounts(match);
    const now = new Date();
    const activeUserIds = await Subscription.distinct('userId', { status: 'active', endDate: { $gte: now } });
    const activeUserIdSet = new Set(activeUserIds.map((id) => id.toString()));
    const activeCount = activeUserIds.length;
    const everActiveUserIds = await Subscription.distinct('userId', { status: 'active', endDate: { $lt: now } });
    const expiredCount = everActiveUserIds.filter((id) => !activeUserIdSet.has(id.toString())).length;

    // Section D3's fix (see utils/localDate.js) applied here too — this
    // was still using raw new Date()/setHours(), the same server-
    // timezone bug already found and fixed in attendanceService.js and
    // rfidController.todayAttendance. Same failure mode: a UTC-
    // configured server would misbucket late-night Manila attendance
    // into the wrong day for this stat specifically.
    const todayStart = startOfLocalDay();
    const todayEnd = endOfLocalDay();
    const dailyAttendance = await Attendance.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } });

    // Most popular plan
    const popular = await Subscription.aggregate([
      { $group: { _id: '$planId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
      { $lookup: { from: 'membershipplans', localField: '_id', foreignField: '_id', as: 'plan' } },
      { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
      { $project: { count: 1, plan: '$plan.name' } }
    ]);

    // Top 5 active members (by attendance)
    const topMembers = await Attendance.aggregate([
      { $group: { _id: '$userId', visits: { $sum: 1 } } },
      { $sort: { visits: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { visits: 1, 'user.fullname': 1, 'user.email': 1 } }
    ]);

    // Top 5 best-selling plans
    const topPlans = await Subscription.aggregate([
      { $group: { _id: '$planId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'membershipplans', localField: '_id', foreignField: '_id', as: 'plan' } },
      { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
      { $project: { count: 1, plan: '$plan.name' } }
    ]);

    res.json({
      totalRevenue,
      newMemberships,
      renewals,
      activeCount,
      expiredCount,
      dailyAttendance,
      mostPopularPlan: popular[0] || null,
      topMembers,
      topPlans,
    });
  } catch (err) { next(err); }
};

// C1 — Income Period Selector. Distinct from `summary` above: that one
// is always "today" for the stat-card grid; this drives the period
// toggle specifically, using Manila-local boundaries (never the
// server's own timezone — see utils/localDate.js) and only counting
// approved payments, same as every other revenue aggregation in this
// file.
const PERIOD_LABELS = {
  today: "Today's Income",
  weekly: 'Weekly Income',
  monthly: 'Monthly Income',
  yearly: 'Yearly Income',
};

function resolvePeriodStart(period, now) {
  if (period === 'weekly') return startOfLocalWeek(now);
  if (period === 'monthly') return startOfLocalMonth(now);
  if (period === 'yearly') return startOfLocalYear(now);
  return startOfLocalDay(now);
}

// A membership "approaching expiration" — active subscriptions whose
// endDate falls within the next N days. This is a snapshot metric (not
// scoped to the Statistics page's period toggle), same as how
// "Expiring Memberships" reads as a standalone fact rather than a
// range total.
const EXPIRING_SOON_DAYS = 7;

// Statistics.vue's "Expiring Memberships" and "Membership Growth" cards
// (previously "New members"/"Current member", driven by `summary`
// above). Kept as its own endpoint rather than folded into `summary`
// since `summary` is always "today" and growth needs to follow the
// page's own Daily/Weekly/Monthly/Yearly period toggle.
exports.membershipOverview = async (req, res, next) => {
  try {
    const period = ['today', 'weekly', 'monthly', 'yearly'].includes(req.query.period)
      ? req.query.period
      : 'today';

    const now = new Date();

    const soonCutoff = new Date(now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000);
    const expiringMemberships = await Subscription.countDocuments({
      status: 'active',
      endDate: { $gte: now, $lte: soonCutoff },
    });

    // Net change in distinct active members between the start of the
    // selected period and now. "Active at instant X" is read off
    // startDate/endDate coverage directly (a subscription document
    // whose window spans X), not the `status` field alone — status can
    // lag behind a passed endDate until a background job runs (see the
    // same reasoning in attendanceService.js's processMemberScan), so
    // date coverage is the authoritative signal here too.
    const periodStart = resolvePeriodStart(period, now);

    const activeUserIdsNow = await Subscription.distinct('userId', {
      startDate: { $lte: now },
      endDate: { $gte: now },
    });
    const activeUserIdsAtPeriodStart = await Subscription.distinct('userId', {
      startDate: { $lte: periodStart },
      endDate: { $gte: periodStart },
    });

    const membershipGrowth = activeUserIdsNow.length - activeUserIdsAtPeriodStart.length;

    res.json({
      period,
      expiringMemberships,
      expiringSoonDays: EXPIRING_SOON_DAYS,
      membershipGrowth,
      activeNow: activeUserIdsNow.length,
      activeAtPeriodStart: activeUserIdsAtPeriodStart.length,
    });
  } catch (err) {
    next(err);
  }
};

// Statistics.vue's "Visitors" donut. Previously computed client-side
// from the full /admin/members list split only by studentPromoActive
// (Student vs "Regular") — that's a membership-roster split, not an
// actual visitor count, and had no concept of non-member walk-ins at
// all. This instead reads real check-ins for the selected period from
// Attendance, using the same conventions the Dashboard's Member/
// Non-member attendance pie already relies on:
//   - subjectType: 'member' scopes to member-side attendance (excludes
//     coach/employee check-ins, which live under subjectType: 'employee').
//   - a record with `userId` set is a member check-in; `memberType`
//     ('Student' vs 'Regular', set at check-in time — see
//     attendanceService.js's processMemberScan) distinguishes Student
//     from the new "Member" (regular, non-student) category.
//   - a record with no `userId` (guestName only) is a walk-in — the
//     new "Non-member" category.
exports.visitorsBreakdown = async (req, res, next) => {
  try {
    const period = ['today', 'weekly', 'monthly', 'yearly'].includes(req.query.period)
      ? req.query.period
      : 'today';

    const now = new Date();
    const start = resolvePeriodStart(period, now);
    const end = endOfLocalDay(now);

    const rows = await Attendance.aggregate([
      { $match: { subjectType: 'member', createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            $cond: [
              { $ifNull: ['$userId', false] },
              { $cond: [{ $eq: ['$memberType', 'Student'] }, 'student', 'member'] },
              'nonMember',
            ],
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const counts = { student: 0, member: 0, nonMember: 0 };
    for (const row of rows) counts[row._id] = row.count;

    res.json({ period, ...counts });
  } catch (err) {
    next(err);
  }
};

exports.incomeByPeriod = async (req, res, next) => {
  try {
    const period = ['today', 'weekly', 'monthly', 'yearly'].includes(req.query.period)
      ? req.query.period
      : 'today';

    const now = new Date();
    let start;
    if (period === 'weekly') start = startOfLocalWeek(now);
    else if (period === 'monthly') start = startOfLocalMonth(now);
    else if (period === 'yearly') start = startOfLocalYear(now);
    else start = startOfLocalDay(now);
    const end = endOfLocalDay(now);

    const result = await Payment.aggregate([
      { $match: { status: 'approved', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    res.json({
      period,
      label: PERIOD_LABELS[period],
      total: result[0] ? result[0].total : 0,
      count: result[0] ? result[0].count : 0,
    });
  } catch (err) {
    next(err);
  }
};

// Sales by custom range grouped by day
exports.salesByRange = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const match = {};
    if (startDate || endDate) match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);

    const sales = await Payment.aggregate([
      { $match: { ...match, status: 'approved' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    res.json({ data: sales });
  } catch (err) { next(err); }
};

exports.incomeByPackage = async (req, res, next) => {
  try {
    const match = parseRange(req.query);

    const results = await Payment.aggregate([
      { $match: { ...match, status: 'approved' } },
      { $group: { _id: '$planId', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
      { $lookup: { from: 'membershipplans', localField: '_id', foreignField: '_id', as: 'plan' } },
      { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
      { $project: { planName: { $ifNull: ['$plan.name', 'No plan specified'] }, total: 1, count: 1 } },
    ]);

    res.json({ data: results });
  } catch (err) { next(err); }
};

exports.incomeByMethod = async (req, res, next) => {
  try {
    const match = parseRange(req.query);

    const results = await Payment.aggregate([
      { $match: { ...match, status: 'approved' } },
      { $group: { _id: '$paymentMethod', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]);

    res.json({ data: results.map((r) => ({ method: r._id || 'Unspecified', total: r.total, count: r.count })) });
  } catch (err) { next(err); }
};

// Export payments in CSV
exports.exportCSV = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const filter = {};
    if (startDate || endDate) filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);

    const payments = await Payment.find(filter).populate('userId', 'fullname email').sort({ createdAt: 1 });
    const header = ['Reference', 'Transaction #', 'User', 'Email', 'Amount', 'Method', 'Status', 'Date'];
    const rows = payments.map(p => [p.referenceNumber || '', p.transactionNumber || '', p.userId?.fullname || '', p.userId?.email || '', p.amount, p.paymentMethod, p.status, p.createdAt.toISOString()]);
    const csv = [header.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))].join('\n');
    res.setHeader('Content-disposition', 'attachment; filename=payments.csv');
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) { next(err); }
};

// Export payments in PDF
exports.exportPDF = async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const { startDate, endDate } = req.query;
    const filter = {};
    if (startDate || endDate) filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);

    const payments = await Payment.find(filter).populate('userId', 'fullname email').sort({ createdAt: 1 });
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-disposition', 'attachment; filename=payments.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);
    doc.fontSize(16).text('Payments Report', { align: 'center' });
    doc.moveDown();
    payments.forEach(p => {
      doc.fontSize(10).text(`Txn: ${p.transactionNumber || '—'} | Ref: ${p.referenceNumber || '—'} | User: ${p.userId?.fullname || ''} | Email: ${p.userId?.email || ''} | Amount: ${p.amount} | Method: ${p.paymentMethod} | Status: ${p.status} | Date: ${p.createdAt.toISOString()}`);
      doc.moveDown(0.2);
    });
    doc.end();
  } catch (err) { next(err); }
};