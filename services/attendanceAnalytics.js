// services/attendanceAnalytics.js
// Rules (see also controllers/adminAnalyticsController.js#attendanceUnique): * A bucket is a Manila calendar day
const {
  formatLocalDateLabel,
  startOfLocalDay,
  endOfLocalDay,
  startOfLocalWeek,
  startOfLocalMonth,
} = require('../utils/localDate');
const { parseRange } = require('../utils/dateRange');

const TZ = 'Asia/Manila';
const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVALS = ['day', 'week', 'month'];
const MAX_SPAN_DAYS = 400;

function isoWeekKey(date) {
  const s = new Date(date.getTime() + OFFSET_MS);
  const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Same key the Mongo pipeline produces ($dateToString with timezone)
function bucketKey(date, interval) {
  const d = new Date(date);
  if (interval === 'week') return isoWeekKey(d);
  if (interval === 'month') return formatLocalDateLabel(d).slice(0, 7);
  return formatLocalDateLabel(d);
}

function labelFor(date, interval) {
  if (interval === 'month') {
    const s = new Date(startOfLocalMonth(date).getTime() + OFFSET_MS);
    return s.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  const base = interval === 'week' ? startOfLocalWeek(date) : startOfLocalDay(date);
  const s = new Date(base.getTime() + OFFSET_MS);
  const txt = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return interval === 'week' ? `Wk of ${txt}` : txt;
}

// Every bucket in [start, end], in order, so empty periods show as 0
function listBuckets(interval, start, end) {
  const out = [];
  const seen = new Set();
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const d = new Date(t);
    const key = bucketKey(d, interval);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: labelFor(d, interval) });
  }
  return out;
}

function defaultStart(interval, now) {
  if (interval === 'week') return startOfLocalWeek(new Date(now.getTime() - 7 * 7 * DAY_MS));
  if (interval === 'month') {
    const s = new Date(now.getTime() + OFFSET_MS);
    s.setUTCDate(1);
    s.setUTCMonth(s.getUTCMonth() - 5);
    return startOfLocalMonth(new Date(s.getTime() - OFFSET_MS));
  }
  return startOfLocalDay(new Date(now.getTime() - 6 * DAY_MS));
}

// { ok, start, end } - defaults: 7 days / 8 weeks / 6 months ending today
function resolveRange(interval, startStr, endStr, now = new Date()) {
  const r = parseRange(startStr || undefined, endStr || undefined);
  if (!r.ok) return r;
  const start = r.start || defaultStart(interval, now);
  const end = r.end || endOfLocalDay(now);
  if (start > end) return { ok: false, message: 'Start date cannot be later than end date.' };
  if ((end - start) / DAY_MS > MAX_SPAN_DAYS) {
    return { ok: false, message: `Date range is too long (maximum ${MAX_SPAN_DAYS} days).` };
  }
  return { ok: true, start, end };
}

// MongoDB pipelines
const bucketExpr = (interval) => ({
  $dateToString: {
    format: interval === 'week' ? '%G-W%V' : interval === 'month' ? '%Y-%m' : '%Y-%m-%d',
    date: '$createdAt',
    timezone: TZ,
  },
});

// People rows only: no employees
const baseMatch = (start, end) => ({
  createdAt: { $gte: start, $lte: end },
  coachId: null,
  subjectType: { $ne: 'employee' },
  attendanceType: { $ne: 'EMPLOYEE' },
});
const kindExpr = { $cond: [{ $ifNull: ['$userId', false] }, 'member', 'nonMember'] };
// Members collapse to their userId; non-members have no identity so each row is its own "person"
const whoExpr = { $ifNull: ['$userId', '$_id'] };

function bucketsPipeline(interval, start, end) {
  return [
    { $match: baseMatch(start, end) },
    { $group: { _id: { bucket: bucketExpr(interval), kind: kindExpr, who: whoExpr }, sessions: { $sum: 1 } } },
    { $group: { _id: { bucket: '$_id.bucket', kind: '$_id.kind' }, people: { $sum: 1 }, sessions: { $sum: '$sessions' } } },
  ];
}

// Distinct across the WHOLE range (not the sum of buckets)
function totalsPipeline(start, end) {
  return [
    { $match: baseMatch(start, end) },
    { $group: { _id: { kind: kindExpr, who: whoExpr }, sessions: { $sum: 1 } } },
    { $group: { _id: '$_id.kind', people: { $sum: 1 }, sessions: { $sum: '$sessions' } } },
  ];
}

// Shaping results
function assembleBuckets(list, rows) {
  const m = new Map(list.map((b) => [b.key, { ...b, uniqueMembers: 0, sessions: 0, nonMembers: 0 }]));
  for (const r of rows) {
    const b = m.get(r._id.bucket);
    if (!b) continue;
    if (r._id.kind === 'member') { b.uniqueMembers = r.people; b.sessions = r.sessions; }
    else b.nonMembers = r.people;
  }
  return [...m.values()];
}

function assembleTotals(rows) {
  const t = { uniqueMembers: 0, memberSessions: 0, nonMembers: 0 };
  for (const r of rows) {
    if (r._id === 'member') { t.uniqueMembers = r.people; t.memberSessions = r.sessions; }
    else if (r._id === 'nonMember') t.nonMembers = r.people;
  }
  return t;
}

// Reference implementation (used by tests to mirror the pipeline)
function inRange(row, start, end) {
  const t = new Date(row.createdAt).getTime();
  return t >= start.getTime() && t <= end.getTime();
}
function isPeopleRow(row) {
  return !row.coachId && row.subjectType !== 'employee' && row.attendanceType !== 'EMPLOYEE';
}

function referenceBuckets(rows, interval, start, end) {
  const groups = new Map();
  for (const r of rows) {
    if (!inRange(r, start, end) || !isPeopleRow(r)) continue;
    const kind = r.userId ? 'member' : 'nonMember';
    const key = `${bucketKey(new Date(r.createdAt), interval)}|${kind}`;
    if (!groups.has(key)) groups.set(key, { who: new Set(), sessions: 0 });
    const g = groups.get(key);
    g.who.add(r.userId ? String(r.userId) : String(r._id));
    g.sessions += 1;
  }
  return [...groups].map(([k, g]) => {
    const [bucket, kind] = k.split('|');
    return { _id: { bucket, kind }, people: g.who.size, sessions: g.sessions };
  });
}

function referenceTotals(rows, start, end) {
  const kinds = { member: { who: new Set(), sessions: 0 }, nonMember: { who: new Set(), sessions: 0 } };
  for (const r of rows) {
    if (!inRange(r, start, end) || !isPeopleRow(r)) continue;
    const k = kinds[r.userId ? 'member' : 'nonMember'];
    k.who.add(r.userId ? String(r.userId) : String(r._id));
    k.sessions += 1;
  }
  return Object.entries(kinds).map(([kind, k]) => ({ _id: kind, people: k.who.size, sessions: k.sessions }));
}

module.exports = {
  TZ, INTERVALS, MAX_SPAN_DAYS,
  bucketKey, labelFor, listBuckets, resolveRange,
  bucketsPipeline, totalsPipeline, assembleBuckets, assembleTotals,
  referenceBuckets, referenceTotals,
};
