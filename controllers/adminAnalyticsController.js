const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Subscription = require('../models/Subscription');
const MembershipPlan = require('../models/MembershipPlan');
const Attendance = require('../models/Attendance');
const User = require('../models/User');

// Helper to parse date range
function parseRange(q) {
  const { startDate, endDate } = q;
  const match = {};
  if (startDate || endDate) match.createdAt = {};
  if (startDate) match.createdAt.$gte = new Date(startDate);
  if (endDate) match.createdAt.$lte = new Date(endDate);
  return match;
}

// A subscription is a "new membership" if it's the earliest subscription
// (by createdAt) that user has ever had — any status, not just active,
// and not limited to the date range — and a "renewal" otherwise. Previously
// newMemberships and renewals ran the exact same countDocuments query, so
// they always reported identical (and meaningless) numbers.
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

    // Total revenue & sales — only approved payments count as real income.
    // Pending/rejected amounts were previously included here, which
    // overstated revenue by whatever was still awaiting admin review.
    const payments = await Payment.aggregate([
      { $match: { ...match, status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const totalRevenue = payments[0] ? payments[0].total : 0;

    // New memberships vs renewals in range — a user's first-ever
    // subscription counts as "new"; any subsequent one is a "renewal".
    const { newMemberships, renewals } = await getNewVsRenewalCounts(match);

    // Active vs expired — was Subscription.countDocuments({status:'active'})
    // / {status:'expired'}. subscriptionService.js's own comment explains
    // why that's wrong: nothing in this codebase ever flips a
    // subscription's status from 'active' to 'expired' as time passes, so
    // the stored status field can't answer "is this active right now" on
    // its own — it only reflects what was true at creation time. A
    // subscription created months ago with status:'active' and an endDate
    // long past would still count here under the old query. This mirrors
    // adminController.js's deriveStatus(), which already gets this right
    // for the member list/detail views — this is the same fix applied to
    // the dashboard's numbers.
    //
    // "Active member" also means one *member*, not one *subscription* row
    // — a member with two subscription rows (e.g. renewed while the old
    // one hadn't technically lapsed) should count once, not twice.
    const now = new Date();
    const activeUserIds = await Subscription.distinct('userId', { status: 'active', endDate: { $gte: now } });
    const activeUserIdSet = new Set(activeUserIds.map((id) => id.toString()));
    const activeCount = activeUserIds.length;

    // Distinct users whose only 'active'-status subscription(s) have all
    // lapsed — excludes anyone already counted in activeCount (e.g. a
    // member with an old expired row plus a newer, still-valid renewal
    // should only ever count as active, never as both).
    const everActiveUserIds = await Subscription.distinct('userId', { status: 'active', endDate: { $lt: now } });
    const expiredCount = everActiveUserIds.filter((id) => !activeUserIdSet.has(id.toString())).length;

    // Daily RFID attendance (today)
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
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

// Income by membership package/plan — Section G requirement: separate
// income totals per package type, not just an overall figure.
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

// Income by payment method (Walk-in/GCash/etc.) — the other Section G
// breakdown that had no endpoint at all before this.
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
    // Reference and Transaction # are now separate columns — previously
    // this only had 'Reference', which (before transactionNumber existed)
    // held either a real GCash reference or a MANUAL-<timestamp>
    // placeholder for cash, indistinguishable from each other.
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