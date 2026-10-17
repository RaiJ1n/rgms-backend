// Unique-member attendance counting
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../services/attendanceAnalytics');

const at = (iso) => new Date(iso);
let n = 0;
const row = (userId, iso, extra = {}) => ({ _id: `a${++n}`, userId, createdAt: at(iso), subjectType: 'member', attendanceType: 'MEMBER', ...extra });
const run = (rows, interval, s, e) => {
  const start = at(s), end = at(e);
  return {
    buckets: A.assembleBuckets(A.listBuckets(interval, start, end), A.referenceBuckets(rows, interval, start, end)),
    totals: A.assembleTotals(A.referenceTotals(rows, start, end)),
  };
};
const DAY = ['2026-10-14T00:00:00+08:00', '2026-10-14T23:59:59+08:00'];

// The exact scenario from the brief
const brief = () => [
  row('A', '2026-10-14T07:00:00+08:00'), row('A', '2026-10-14T10:00:00+08:00'), row('A', '2026-10-14T15:00:00+08:00'),
  row('B', '2026-10-14T08:00:00+08:00'),
  row('C', '2026-10-14T09:00:00+08:00'), row('C', '2026-10-14T13:00:00+08:00'),
];

test('6 sessions by 3 members on one day = 3 unique members, 6 sessions', () => {
  const { buckets, totals } = run(brief(), 'day', ...DAY);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].uniqueMembers, 3);
  assert.equal(buckets[0].sessions, 6);
  assert.equal(totals.uniqueMembers, 3);
});

test('another check-in by an existing member the same day leaves the count unchanged', () => {
  const rows = [...brief(), row('A', '2026-10-14T19:00:00+08:00')];
  const { buckets } = run(rows, 'day', ...DAY);
  assert.equal(buckets[0].uniqueMembers, 3);
  assert.equal(buckets[0].sessions, 7);
});

test('a member on several days counts once per day, once per week, once per month', () => {
  const rows = [row('A', '2026-10-12T08:00:00+08:00'), row('A', '2026-10-14T08:00:00+08:00'), row('A', '2026-10-16T08:00:00+08:00'), row('B', '2026-10-14T09:00:00+08:00')];
  const d = run(rows, 'day', '2026-10-12T00:00:00+08:00', '2026-10-18T23:59:59+08:00');
  assert.deepEqual(d.buckets.map((b) => b.uniqueMembers), [1, 0, 2, 0, 1, 0, 0]);
  const w = run(rows, 'week', '2026-10-12T00:00:00+08:00', '2026-10-18T23:59:59+08:00');
  assert.equal(w.buckets.length, 1);
  assert.equal(w.buckets[0].uniqueMembers, 2);
  assert.equal(w.buckets[0].sessions, 4);
  const m = run(rows, 'month', '2026-10-01T00:00:00+08:00', '2026-10-31T23:59:59+08:00');
  assert.equal(m.buckets[0].uniqueMembers, 2);
});

test('the same member in two different weeks counts once in EACH week but once in the range total', () => {
  const rows = [row('A', '2026-10-13T08:00:00+08:00'), row('A', '2026-10-20T08:00:00+08:00')];
  const w = run(rows, 'week', '2026-10-12T00:00:00+08:00', '2026-10-25T23:59:59+08:00');
  assert.deepEqual(w.buckets.map((b) => b.uniqueMembers), [1, 1]);
  assert.equal(w.totals.uniqueMembers, 1);
});

test('identity is the member id, not the name: same-name members stay separate', () => {
  const rows = [row('id-1', '2026-10-14T08:00:00+08:00', { name: 'Juan Cruz' }), row('id-2', '2026-10-14T09:00:00+08:00', { name: 'Juan Cruz' })];
  assert.equal(run(rows, 'day', ...DAY).buckets[0].uniqueMembers, 2);
});

test('original card + temporary card sessions carry the same userId = one member', () => {
  const rows = [row('M1', '2026-10-14T07:00:00+08:00', { rfidCardId: 'original' }), row('M1', '2026-10-14T11:00:00+08:00', { rfidCardId: 'temp-card' })];
  const { buckets } = run(rows, 'day', ...DAY);
  assert.equal(buckets[0].uniqueMembers, 1);
  assert.equal(buckets[0].sessions, 2);
});

test('visitors/walk-ins are never counted as members; employees are excluded', () => {
  const rows = [
    row('A', '2026-10-14T08:00:00+08:00'),
    { _id: 'v1', createdAt: at('2026-10-14T09:00:00+08:00'), subjectType: 'member', attendanceType: 'VISITOR', guestName: 'Pat' },
    { _id: 'v2', createdAt: at('2026-10-14T10:00:00+08:00'), subjectType: 'member', attendanceType: 'VISITOR', guestName: 'Pat' },
    { _id: 'g1', createdAt: at('2026-10-14T11:00:00+08:00'), subjectType: 'member', attendanceType: 'GUEST', guestName: 'Walk-in' },
    { _id: 'e1', coachId: 'coach1', createdAt: at('2026-10-14T06:00:00+08:00'), subjectType: 'employee', attendanceType: 'EMPLOYEE' },
  ];
  const { buckets, totals } = run(rows, 'day', ...DAY);
  assert.equal(buckets[0].uniqueMembers, 1);
  assert.equal(buckets[0].nonMembers, 3);
  assert.equal(totals.uniqueMembers, 1);
  assert.equal(totals.nonMembers, 3);
});

test('Manila day boundaries: 00:10 Manila is the NEW day even though it is the previous day in UTC', () => {
  const rows = [
    row('A', '2026-10-14T23:30:00+08:00'),
    row('B', '2026-10-15T00:10:00+08:00'),
    row('C', '2026-10-15T07:59:00+08:00'),
  ];
  const { buckets } = run(rows, 'day', '2026-10-14T00:00:00+08:00', '2026-10-15T23:59:59+08:00');
  assert.deepEqual(buckets.map((b) => [b.key, b.uniqueMembers]), [['2026-10-14', 1], ['2026-10-15', 2]]);
});

test('rows outside the selected range are ignored', () => {
  const rows = [row('A', '2026-10-13T23:59:59+08:00'), row('B', '2026-10-14T08:00:00+08:00'), row('C', '2026-10-15T00:00:00+08:00')];
  assert.equal(run(rows, 'day', ...DAY).totals.uniqueMembers, 1);
});

test('ISO week keys, including the year boundary, and zero-filled month buckets', () => {
  assert.equal(A.bucketKey(at('2026-12-31T12:00:00+08:00'), 'week'), '2026-W53');
  assert.equal(A.bucketKey(at('2027-01-01T12:00:00+08:00'), 'week'), '2026-W53');
  assert.equal(A.bucketKey(at('2027-01-04T00:30:00+08:00'), 'week'), '2027-W01');
  assert.equal(A.bucketKey(at('2026-10-31T23:30:00+08:00'), 'month'), '2026-10');
  assert.equal(A.bucketKey(at('2026-11-01T00:30:00+08:00'), 'month'), '2026-11');
  const keys = A.listBuckets('month', at('2026-08-01T00:00:00+08:00'), at('2026-10-31T23:59:59+08:00')).map((b) => b.key);
  assert.deepEqual(keys, ['2026-08', '2026-09', '2026-10']);
});

test('default ranges: 7 days / 8 weeks / 6 months, ending today (Manila)', () => {
  const now = at('2026-10-15T10:00:00+08:00');
  const d = A.resolveRange('day', undefined, undefined, now);
  assert.equal(A.listBuckets('day', d.start, d.end).length, 7);
  const w = A.resolveRange('week', undefined, undefined, now);
  assert.equal(A.listBuckets('week', w.start, w.end).length, 8);
  const m = A.resolveRange('month', undefined, undefined, now);
  assert.equal(A.listBuckets('month', m.start, m.end).length, 6);
});

test('resolveRange rejects bad / reversed / oversized ranges', () => {
  assert.equal(A.resolveRange('day', 'nope', '2026-10-14').ok, false);
  assert.equal(A.resolveRange('day', '2026-10-15', '2026-10-14').ok, false);
  assert.equal(A.resolveRange('day', '2024-01-01', '2026-10-14').ok, false);
  assert.equal(A.resolveRange('day', '2026-10-01', '2026-10-14').ok, true);
});

test('pipeline: groups by member id inside each Manila bucket, filters employees, never touches data', () => {
  const p = A.bucketsPipeline('week', at('2026-10-12T00:00:00+08:00'), at('2026-10-18T23:59:59+08:00'));
  const json = JSON.stringify(p);
  assert.match(json, /Asia\/Manila/);
  assert.match(json, /%G-W%V/);
  assert.equal(p.length, 3);
  assert.ok(p[0].$match && p[1].$group && p[2].$group);
  assert.equal(p[0].$match.coachId, null);
  assert.deepEqual(p[0].$match.attendanceType, { $ne: 'EMPLOYEE' });
  assert.ok(!json.includes('$out') && !json.includes('$merge'), 'analytics must be read-only');
  assert.ok(JSON.stringify(p[1].$group._id.who).includes('$userId'));
  const t = A.totalsPipeline(at('2026-10-12T00:00:00+08:00'), at('2026-10-18T23:59:59+08:00'));
  assert.equal(t.length, 3);
});
