// services/attendanceHistoryService.js
// Nothing here groups, de-duplicates or "takes the first record of the day"
const Attendance = require('../models/Attendance');
const { startOfLocalDay, endOfLocalDay, formatLocalDateLabel } = require('../utils/localDate');

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

function ownerKey(row) {
  const o = idOf(row.userId) || idOf(row.coachId);
  return o ? `${o}` : null;
}

function dayOf(row) {
  const t = row.checkIn || row.createdAt;
  return t ? formatLocalDateLabel(new Date(t)) : null;
}

function statusOf(row, now = new Date()) {
  if (row.checkOut) return 'Completed';
  if (row.missedCheckOut) return 'No time-out';
  const t = row.checkIn || row.createdAt;
  if (t && new Date(t) < startOfLocalDay(now)) return 'No time-out';
  return 'Inside';
}

// Pure
function numberSessions(rows, siblings) {
  const wanted = new Set();
  for (const r of rows) {
    const k = ownerKey(r);
    if (k) wanted.add(`${k}|${dayOf(r)}`);
  }
  const groups = new Map();
  for (const s of siblings) {
    const k = ownerKey(s);
    if (!k) continue;
    const g = `${k}|${dayOf(s)}`;
    if (!wanted.has(g)) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const out = new Map();
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const d = new Date(a.checkIn || a.createdAt) - new Date(b.checkIn || b.createdAt);
      return d || String(a._id).localeCompare(String(b._id));
    });
    list.forEach((s, i) => out.set(String(s._id), { sessionNo: i + 1, sessionsThatDay: list.length }));
  }
  return out;
}

// Adds status / sessionNo / sessionsThatDay / dayKey to plain row objects
async function decorate(rows, now = new Date()) {
  const owners = new Set();
  let min = null;
  let max = null;
  for (const r of rows) {
    const k = ownerKey(r);
    if (!k) continue;
    owners.add(k);
    const t = new Date(r.checkIn || r.createdAt);
    if (!min || t < min) min = t;
    if (!max || t > max) max = t;
  }

  let numbering = new Map();
  if (owners.size) {
    const ids = [...owners];
    const siblings = await Attendance.find({
      $or: [{ userId: { $in: ids } }, { coachId: { $in: ids } }],
      createdAt: { $gte: startOfLocalDay(min), $lte: endOfLocalDay(max) },
    }).select('userId coachId checkIn createdAt').lean();
    numbering = numberSessions(rows, siblings);
  }

  return rows.map((r) => {
    const n = numbering.get(String(r._id));
    return {
      ...r,
      dayKey: r.dayKey || dayOf(r),
      status: statusOf(r, now),
      sessionNo: n ? n.sessionNo : null,
      sessionsThatDay: n ? n.sessionsThatDay : null,
    };
  });
}

// Filter pieces from a query string
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateFilter(startDate, endDate) {
  const { parseRange } = require('../utils/dateRange');
  const isDay = (v) => typeof v === 'string' && DAY_RE.test(v.trim());
  const range = {};

  if ((!startDate || isDay(startDate)) && (!endDate || isDay(endDate))) {
    const r = parseRange(startDate || undefined, endDate || undefined);
    if (!r.ok) return r;
    if (r.start) range.$gte = r.start;
    if (r.end) range.$lte = r.end;
  } else {
    if (startDate) {
      const d = new Date(startDate);
      if (Number.isNaN(d.getTime())) return { ok: false, message: 'Start date is not valid.' };
      range.$gte = d;
    }
    if (endDate) {
      const d = new Date(endDate);
      if (Number.isNaN(d.getTime())) return { ok: false, message: 'End date is not valid.' };
      range.$lte = d;
    }
  }
  return { ok: true, range: Object.keys(range).length ? range : null };
}

// "Still inside" = no Time-Out recorded AND opened today
function insideFilter(now = new Date()) {
  return { checkOut: { $exists: false }, createdAt: { $gte: startOfLocalDay(now) }, missedCheckOut: { $ne: true } };
}

module.exports = { statusOf, numberSessions, decorate, dateFilter, insideFilter, dayOf, ownerKey };
