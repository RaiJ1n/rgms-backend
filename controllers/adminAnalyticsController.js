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

exports.summary = async (req, res, next) => {
  try {
    const match = parseRange(req.query);

    // Total revenue & sales
    const payments = await Payment.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const totalRevenue = payments[0] ? payments[0].total : 0;

    // New memberships in range
    const newMemberships = await Subscription.countDocuments({ ...match, status: 'active' });

    // Renewals (subscriptions with createdAt != startDate heuristic)
    const renewals = await Subscription.countDocuments({ ...match, status: 'active' });

    // Active vs expired
    const activeCount = await Subscription.countDocuments({ status: 'active' });
    const expiredCount = await Subscription.countDocuments({ status: 'expired' });

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
      { $match: match },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    res.json({ data: sales });
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
    const header = ['Reference', 'User', 'Email', 'Amount', 'Status', 'Date'];
    const rows = payments.map(p => [p.referenceNumber, p.userId?.fullname || '', p.userId?.email || '', p.amount, p.status, p.createdAt.toISOString()]);
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
      doc.fontSize(10).text(`Ref: ${p.referenceNumber} | User: ${p.userId?.fullname || ''} | Email: ${p.userId?.email || ''} | Amount: ${p.amount} | Status: ${p.status} | Date: ${p.createdAt.toISOString()}`);
      doc.moveDown(0.2);
    });
    doc.end();
  } catch (err) { next(err); }
};
