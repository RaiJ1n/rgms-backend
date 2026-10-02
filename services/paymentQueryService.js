// services/paymentQueryService.js
//
// ONE implementation of "which payments match these filters, in which order"
// that the Payment History list, its Excel export and its summary report all
// call — so the table, the spreadsheet and the totals can never disagree, and
// filtering/sorting happen in the database (correct with pagination) instead
// of on whichever page the browser happened to load.
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const User = require('../models/User');
const MembershipPlan = require('../models/MembershipPlan');
const escapeRegex = require('../utils/escapeRegex');
const { parseRange } = require('../utils/dateRange');

const STATUSES = ['pending', 'approved', 'rejected'];
const CUSTOMER_TYPES = ['MEMBER', 'WALK_IN'];

// Public sort keys -> what the pipeline actually sorts on.
const SORT_FIELDS = {
  date: 'createdAt',
  amount: 'amount',
  transactionNumber: 'transactionNumber',
  customer: '_customerSort',
  method: 'paymentMethod',
  package: '_planSort',
  status: 'status',
};

// Query-string values arrive as whatever the client sent (`?status[$ne]=x`
// parses to an object). Only ever accept plain strings.
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Builds the Mongo match for a set of Payment History filters.
 * Returns { filter } or { error }.
 *
 * Filters: startDate/endDate (inclusive Manila days), method, status,
 * planId (package), customerType, search (customer name, transaction number,
 * reference number).
 */
async function buildFilter(query = {}) {
  const filter = {};

  // `?status[$ne]=x` / `?method[$gt]=` arrive as OBJECTS. Reject anything that
  // is not a plain string outright rather than silently dropping the filter
  // (which would show the admin MORE rows than they asked for).
  for (const key of ['startDate', 'endDate', 'method', 'status', 'planId', 'customerType', 'search']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') {
      return { error: `Invalid value for "${key}".` };
    }
  }

  const range = parseRange(str(query.startDate), str(query.endDate));
  if (!range.ok) return { error: range.message };
  if (range.start || range.end) {
    filter.createdAt = {};
    if (range.start) filter.createdAt.$gte = range.start;
    if (range.end) filter.createdAt.$lte = range.end;
  }

  const method = str(query.method);
  if (method && method !== 'All') filter.paymentMethod = method;

  const status = str(query.status);
  if (status && status !== 'All') {
    if (!STATUSES.includes(status)) return { error: 'Invalid payment status.' };
    filter.status = status;
  }

  const planId = str(query.planId);
  if (planId && planId !== 'All') {
    if (!mongoose.isValidObjectId(planId)) return { error: 'Invalid package.' };
    filter.planId = new mongoose.Types.ObjectId(planId);
  }

  const customerType = str(query.customerType).toUpperCase();
  if (customerType && customerType !== 'ALL') {
    if (!CUSTOMER_TYPES.includes(customerType)) return { error: 'Invalid customer type.' };
    // Payments created before customerType existed have no value — they are
    // member payments, so MEMBER must match "anything that is not WALK_IN".
    filter.customerType = customerType === 'WALK_IN' ? 'WALK_IN' : { $ne: 'WALK_IN' };
  }

  const search = str(query.search);
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    const matchingUsers = await User.find({ fullname: re }).select('_id');
    filter.$or = [
      { referenceNumber: re },
      { transactionNumber: re },
      { customerName: re },
      { userId: { $in: matchingUsers.map((u) => u._id) } },
    ];
  }

  return { filter };
}

function parseSort(query = {}) {
  const key = Object.prototype.hasOwnProperty.call(SORT_FIELDS, str(query.sortBy)) ? str(query.sortBy) : 'date';
  const order = str(query.order).toLowerCase() === 'asc' ? 1 : -1;
  return { key, field: SORT_FIELDS[key], order };
}

// match -> join member + package (so we can sort by their NAMES) -> sort ->
// page -> reshape to the same populated form the frontend already reads
// (`p.userId.fullname`, `p.planId.name`).
function listPipeline(filter, sort, skip, limit) {
  const stages = [
    { $match: filter },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: '_u' } },
    { $lookup: { from: 'membershipplans', localField: 'planId', foreignField: '_id', as: '_p' } },
    { $addFields: { _user: { $arrayElemAt: ['$_u', 0] }, _plan: { $arrayElemAt: ['$_p', 0] } } },
    {
      $addFields: {
        _customerSort: { $toLower: { $ifNull: ['$customerName', { $ifNull: ['$_user.fullname', ''] }] } },
        _planSort: { $toLower: { $ifNull: ['$_plan.name', ''] } },
      },
    },
    { $sort: { [sort.field]: sort.order, _id: sort.order } }, // _id: stable order across pages
  ];
  if (skip) stages.push({ $skip: skip });
  if (limit) stages.push({ $limit: limit });
  stages.push(
    {
      $addFields: {
        userId: {
          $cond: [
            { $ifNull: ['$_user', false] },
            { _id: '$_user._id', fullname: '$_user.fullname', email: '$_user.email', phone: '$_user.phone' },
            null,
          ],
        },
        planId: {
          $cond: [
            { $ifNull: ['$_plan', false] },
            { _id: '$_plan._id', name: '$_plan.name', duration: '$_plan.duration' },
            null,
          ],
        },
      },
    },
    { $project: { _u: 0, _p: 0, _user: 0, _plan: 0, _customerSort: 0, _planSort: 0 } }
  );
  return stages;
}

async function listPayments(query, { page, limit, skip }) {
  const built = await buildFilter(query);
  if (built.error) return { error: built.error };
  const sort = parseSort(query);
  const [total, data] = await Promise.all([
    Payment.countDocuments(built.filter),
    Payment.aggregate(listPipeline(built.filter, sort, skip, limit)),
  ]);
  return { data, total, sort };
}

/**
 * Totals for the SAME filter set. Revenue counts only APPROVED payments —
 * pending/rejected rows are listed in the counts but never add to money.
 * "Cash" is the existing 'Walk-in' payment method (money handed over at the
 * front desk); GCash is 'GCash'.
 */
async function summarize(filter) {
  const rows = await Payment.aggregate([
    { $match: filter },
    {
      $group: {
        _id: { planId: '$planId', method: '$paymentMethod', status: '$status', customerType: '$customerType' },
        count: { $sum: 1 },
        amount: { $sum: '$amount' },
      },
    },
  ]);

  const uniquePlanIds = new Map();
  for (const r of rows) if (r._id.planId) uniquePlanIds.set(String(r._id.planId), r._id.planId);
  const planIds = [...uniquePlanIds.values()]; // keep real ObjectIds for the $in
  const plans = planIds.length ? await MembershipPlan.find({ _id: { $in: planIds } }).select('name') : [];
  const planName = new Map(plans.map((p) => [String(p._id), p.name]));

  const s = {
    totalTransactions: 0,
    totalRevenue: 0,
    totalCash: 0,
    totalGcash: 0,
    totalOtherMethods: 0,
    byStatus: { approved: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, rejected: { count: 0, amount: 0 } },
    byCustomerType: { MEMBER: { count: 0, revenue: 0 }, WALK_IN: { count: 0, revenue: 0 } },
    byPackage: [],
  };
  const pkg = new Map();

  for (const r of rows) {
    const { planId, method, status, customerType } = r._id;
    const type = customerType === 'WALK_IN' ? 'WALK_IN' : 'MEMBER';
    s.totalTransactions += r.count;
    if (s.byStatus[status]) {
      s.byStatus[status].count += r.count;
      s.byStatus[status].amount += r.amount;
    }
    s.byCustomerType[type].count += r.count;

    const key = planId ? String(planId) : 'none';
    if (!pkg.has(key)) pkg.set(key, { planId: planId || null, name: planName.get(key) || 'No package', transactions: 0, approvedTransactions: 0, revenue: 0 });
    const p = pkg.get(key);
    p.transactions += r.count;

    if (status === 'approved') {
      s.totalRevenue += r.amount;
      s.byCustomerType[type].revenue += r.amount;
      p.approvedTransactions += r.count;
      p.revenue += r.amount;
      if (method === 'Walk-in') s.totalCash += r.amount;
      else if (method === 'GCash') s.totalGcash += r.amount;
      else s.totalOtherMethods += r.amount;
    }
  }
  s.byPackage = [...pkg.values()].sort((a, b) => b.revenue - a.revenue);
  return s;
}

module.exports = { buildFilter, parseSort, listPipeline, listPayments, summarize, SORT_FIELDS };