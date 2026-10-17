// services/attendanceQueryService.js
const User = require('../models/User');
const Coach = require('../models/Coach');
const escapeRegex = require('../utils/escapeRegex');
const history = require('./attendanceHistoryService');

async function buildLogFilter(query) {
  const { startDate, endDate, search, status } = query;
  const filter = {};

  const df = history.dateFilter(startDate, endDate);
  if (!df.ok) return { ok: false, message: df.message };
  if (df.range) filter.createdAt = df.range;

  if (status === 'inside') Object.assign(filter, history.insideFilter());
  if (status === 'completed') filter.checkOut = { $exists: true };

  const term = typeof search === 'string' ? search.trim().slice(0, 80) : '';
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    const [users, coaches] = await Promise.all([
      User.find({ fullname: rx }).select('_id').limit(500).lean(),
      Coach.find({ fullname: rx }).select('_id').limit(500).lean(),
    ]);
    filter.$or = [
      { userId: { $in: users.map((u) => u._id) } },
      { coachId: { $in: coaches.map((c) => c._id) } },
      { guestName: rx },
    ];
  }
  return { ok: true, filter };
}

module.exports = { buildLogFilter };
