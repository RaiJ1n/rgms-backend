// test/memberSessions.test.js - run with:  npm test
//
// Multiple Time-In / Time-Out sessions per day, duplicate/double-tap
// protection, idempotent retries and honest failure reporting, against the real
// service/controller code with the Mongoose models replaced by an in-memory
// store that simulates the schema's unique indexes (see test/helpers/fakeStore).
// It verifies application logic; it does NOT prove real MongoDB behaviour, so
// the staging checklist in ATTENDANCE_FIX.md still applies.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
delete process.env.RFID_HASH_SECRET;

const { install, dup, nid, same } = require('./helpers/fakeStore');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const cardLookup = require('../services/rfidCardLookup');

const cards = []; const attendance = []; const users = []; const subs = [];
install(RFIDCard, cards, { active: true, cardType: 'MEMBER' }, (d, s) => { if (s.some((x) => x.cardId === d.cardId)) throw dup(); });
// Mirrors the Attendance schema's unique partial indexes.
install(Attendance, attendance, {}, (d, s) => {
  if (d.openSession === true && s.some((x) => x.openSession === true && same(x.userId, d.userId))) throw dup();
  if (typeof d.requestId === 'string' && s.some((x) => x.requestId === d.requestId)) throw dup();
  if (typeof d.checkOutRequestId === 'string' && s.some((x) => x.checkOutRequestId === d.checkOutRequestId)) throw dup();
});
install(User, users, { isActive: true, role: 'user' });
install(Subscription, subs);
AuditLog.create = async () => ({});
cardLookup.findByUid = (uid) => ({
  populate() { return this; },
  then(res, rej) { return Promise.resolve(cards.find((c) => c.cardId === uid) || null).then(res, rej); },
});
const socketUtil = require('../utils/socket');
socketUtil.emitToAdmins = () => {}; socketUtil.emitToUser = () => {};
const deductions = [];
require('../services/subscriptionService').recordAttendanceSession = async (id) => { deductions.push(String(id)); };

const attendanceService = require('../services/attendanceService');
const memberAttendance = require('../services/memberAttendanceService');
const adminController = require('../controllers/adminController');
const errorMiddleware = require('../middleware/errorMiddleware');

// ------------------------------------------------------------------- helpers
const UID = 'AAAA1111';
const day = 24 * 3600 * 1000;
let M, M2;
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
// Calls the real controller; unexpected errors go to the real error middleware,
// exactly as Express would do.
const manual = async (body, headers = {}) => {
  const r = res();
  const req = { user: { _id: nid(), role: 'admin' }, body, query: {}, params: {}, get: (h) => headers[h], method: 'POST', originalUrl: '/api/admin/attendance/manual' };
  await adminController.createManualAttendance(req, r, (err) => errorMiddleware(err, req, r, () => {}));
  return r;
};
const timeIn = (extra = {}) => manual({ userId: M._id, action: 'checkin', ...extra });
const timeOut = (extra = {}) => manual({ userId: M._id, action: 'checkout', ...extra });
// Quiet reader: move the last-signal marker back past the debounce window instead of sleeping.
const settle = () => cards.forEach((c) => { if (c.lastScannedAt) c.lastScannedAt = new Date(Date.now() - 60_000); if (c.lastSignalAt) c.lastSignalAt = new Date(Date.now() - 60_000); });
const tap = async (uid = UID) => { settle(); return attendanceService.processScan(uid); };
const mine = () => attendance.filter((a) => same(a.userId, M._id));
const open = () => mine().filter((a) => !a.checkOut);

function addMember(name, cardUid) {
  const u = { _id: nid(), fullname: name, email: `${name.toLowerCase().replace(/\s/g, '')}@x.test`, role: 'user', isActive: true };
  users.push(u);
  subs.push({ _id: nid(), userId: u._id, status: 'active', endDate: new Date(Date.now() + 30 * day) });
  if (cardUid) cards.push({ _id: nid(), cardId: cardUid, cardType: 'MEMBER', active: true, userId: u, createdAt: new Date() });
  return u;
}
test.beforeEach(() => {
  [cards, attendance, users, subs, deductions].forEach((a) => { a.length = 0; });
  M = addMember('Maria Santos', UID);
  M2 = addMember('Juan Dela Cruz', 'BBBB2222');
});

// ------------------------------------------------------- sessions (manual)
test('Time-In then Time-Out saves a session with the server timestamps', async () => {
  const a = await timeIn();
  assert.equal(a.code, 201);
  assert.equal(a.body.success, true);
  assert.ok(a.body.data.checkIn);
  assert.equal(a.body.data.checkOut, undefined);
  assert.equal(mine().length, 1);
  const b = await timeOut();
  assert.equal(b.code, 200);
  assert.ok(b.body.data.checkOut);
  assert.equal(mine().length, 1, 'time-out updates the session, it never adds a row');
  assert.ok(mine()[0].checkOut >= mine()[0].checkIn);
  assert.equal(mine()[0].openSession, undefined, 'closed session is no longer open');
});

test('several sessions in one day: each Time-In is a new row, each Time-Out closes the right one', async () => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await timeIn();
    assert.equal(r.code, 201);
    ids.push(String(r.body.data._id));
    if (i < 2) {
      const o = await timeOut();
      assert.equal(String(o.body.data._id), ids[i], `time-out #${i + 1} closed session #${i + 1}`);
    }
  }
  const rows = mine();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => String(r._id)), ids);
  assert.equal(rows.filter((r) => r.checkOut).length, 2);
  assert.equal(open().length, 1, 'the third session stays active until timed out');
  assert.ok(rows.every((r) => r.dayKey === rows[0].dayKey), 'all on the same date');
  // earlier sessions' timestamps are never overwritten by later ones
  assert.ok(rows[0].checkOut <= rows[1].checkIn && rows[1].checkOut <= rows[2].checkIn);
});

test('a subscription session is a gym day: only the first Time-In of the day deducts', async () => {
  await timeIn(); await timeOut(); await timeIn(); await timeOut(); await timeIn();
  assert.equal(mine().length, 3);
  assert.deepEqual(deductions, [String(M._id)]);
});

test('Time-In while a session is open is refused and creates nothing', async () => {
  await timeIn();
  const r = await timeIn();
  assert.equal(r.code, 409);
  assert.equal(r.body.errorType, 'already_checked_in');
  assert.match(r.body.message, /time out first/i);
  assert.equal(mine().length, 1);
});

test('Time-Out with no open session is refused', async () => {
  const r = await timeOut();
  assert.equal(r.code, 409);
  assert.equal(r.body.errorType, 'not_checked_in');
  await timeIn(); await timeOut();
  assert.equal((await timeOut()).code, 409, 'cannot time out twice');
  assert.equal(mine().length, 1);
});

test('sessions belong to the right member', async () => {
  await timeIn();
  await manual({ userId: M2._id, action: 'checkin' });
  const o = await timeOut();
  assert.ok(same(o.body.data.userId, M._id));
  assert.equal(attendance.filter((a) => same(a.userId, M2._id) && !a.checkOut).length, 1, "M2's session untouched");
});

// ---------------------------------------------------------- double taps
test('rapid double Time-In (no key) creates ONE session', async () => {
  const [a, b] = await Promise.all([timeIn(), timeIn()]);
  assert.deepEqual([a.code, b.code].sort(), [201, 409]);
  assert.equal(mine().length, 1);
  assert.equal(open().length, 1);
  assert.equal(deductions.length, 1);
});

test('rapid double Time-In with the same request id: one session, both callers get the same record', async () => {
  const k = 'req-time-in-0001';
  const [a, b] = await Promise.all([timeIn({ requestId: k }), timeIn({ requestId: k })]);
  assert.deepEqual([a.code, b.code].sort(), [200, 201]);
  assert.equal(String(a.body.data._id), String(b.body.data._id));
  assert.equal(mine().length, 1);
  assert.equal(deductions.length, 1);
});

test('rapid double Time-Out closes the session once and leaves its timestamp alone', async () => {
  await timeIn();
  const [a, b] = await Promise.all([timeOut(), timeOut()]);
  assert.deepEqual([a.code, b.code].sort(), [200, 409]);
  assert.equal(mine().length, 1);
  const stamp = +mine()[0].checkOut;
  await timeOut(); // late third attempt
  assert.equal(+mine()[0].checkOut, stamp);
});

test('many simultaneous Time-Ins never produce more than one open session', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => timeIn()));
  assert.equal(results.filter((r) => r.code === 201).length, 1);
  assert.equal(results.filter((r) => r.code === 409).length, 11);
  assert.equal(open().length, 1);
  assert.equal(mine().length, 1);
});

test('RFID tap and admin Time-In racing: never two rows, never two open sessions, one deduction', async () => {
  settle();
  const [t, m] = await Promise.allSettled([attendanceService.processScan(UID), timeIn()]);
  // A tap is a toggle: if the admin's Time-In lands first, the tap is a (valid) Time-Out
  // of that same session; if the tap lands first, the admin's request is refused.
  assert.equal(mine().length, 1, 'one session row, not two');
  assert.ok(mine().filter((a) => a.openSession === true).length <= 1);
  assert.equal(deductions.length, 1);
  const okCount = [t.status === 'fulfilled', m.status === 'fulfilled' && m.value.code === 201].filter(Boolean).length;
  assert.ok(okCount >= 1);
});

// --------------------------------------------------- idempotent retries
test('retrying a Time-In after a lost response returns the original session (no second row)', async () => {
  const k = 'retry-in-000001';
  const first = await timeIn({ requestId: k });
  assert.equal(first.code, 201);
  const retry = await timeIn({ requestId: k });
  assert.equal(retry.code, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(String(retry.body.data._id), String(first.body.data._id));
  assert.equal(mine().length, 1);
  assert.equal(deductions.length, 1);
});

test('retrying a Time-Out after a lost response does not close anything else or repeat the action', async () => {
  await timeIn();
  const k = 'retry-out-00001';
  const first = await timeOut({ requestId: k });
  assert.equal(first.code, 200);
  await timeIn(); // member starts session 2
  const retry = await timeOut({ requestId: k }); // stale retry of the FIRST time-out
  assert.equal(retry.code, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(String(retry.body.data._id), String(first.body.data._id));
  assert.equal(open().length, 1, 'session 2 must NOT have been closed by the retry');
});

test('a request id cannot be reused for a different member; bad ids are rejected', async () => {
  const k = 'shared-key-0001';
  await timeIn({ requestId: k });
  const other = await manual({ userId: M2._id, action: 'checkin', requestId: k });
  assert.equal(other.code, 409);
  assert.equal(other.body.errorType, 'request_id_conflict');
  assert.equal(attendance.filter((a) => same(a.userId, M2._id)).length, 0);
  const bad = await manual({ userId: M._id, action: 'checkin', requestId: 'x' });
  assert.equal(bad.code, 400);
  assert.equal(bad.body.errorType, 'invalid_request_id');
});

test('Idempotency-Key header works like requestId', async () => {
  const k = 'header-key-00001';
  const a = await manual({ userId: M._id, action: 'checkin' }, { 'Idempotency-Key': k });
  const b = await manual({ userId: M._id, action: 'checkin' }, { 'Idempotency-Key': k });
  assert.equal(a.code, 201);
  assert.equal(b.code, 200);
  assert.equal(mine().length, 1);
});

// -------------------------------------------------- failures are honest
test('a failed database write returns an error (never success), saves nothing, and a retry with the same key works', async () => {
  const realCreate = Attendance.create;
  Attendance.create = async () => { throw Object.assign(new Error('connection timed out'), { name: 'MongoNetworkTimeoutError' }); };
  const logged = [];
  const realErr = console.error; console.error = (...a) => logged.push(a);
  let r;
  try { r = await timeIn({ requestId: 'fail-then-ok-001' }); } finally { Attendance.create = realCreate; console.error = realErr; }
  assert.equal(r.code, 500);
  assert.equal(r.body.success, false);
  assert.equal(r.body.retryable, true);
  assert.equal(mine().length, 0, 'nothing saved');
  assert.equal(deductions.length, 0, 'no session deducted for a failed save');
  assert.ok(logged.some((l) => l[0] === '[ERROR]' && /timed out/.test(JSON.stringify(l[1]))), 'failure is logged on the server');

  const retry = await timeIn({ requestId: 'fail-then-ok-001' });
  assert.equal(retry.code, 201);
  assert.equal(mine().length, 1);
});

test('production never leaks driver text on a 5xx; duplicate keys are not mislabelled as payment references', async () => {
  const env = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  const realErr = console.error; console.error = () => {};
  try {
    const r5 = res();
    errorMiddleware(Object.assign(new Error('mongodb://user:secret@host/db failed'), { statusCode: 500 }), { method: 'POST', originalUrl: '/x?y=1' }, r5, () => {});
    assert.equal(r5.code, 500);
    assert.doesNotMatch(JSON.stringify(r5.body), /secret|mongodb:/);
    assert.equal(r5.body.stack, undefined);

    const dupAtt = res();
    errorMiddleware(Object.assign(new Error('E11000'), { code: 11000, keyPattern: { userId: 1 } }), { method: 'POST', originalUrl: '/a' }, dupAtt, () => {});
    assert.equal(dupAtt.code, 409);
    assert.doesNotMatch(dupAtt.body.message, /reference number/);

    const dupPay = res();
    errorMiddleware(Object.assign(new Error('E11000'), { code: 11000, keyPattern: { transactionNumber: 1 } }), { method: 'POST', originalUrl: '/p' }, dupPay, () => {});
    assert.equal(dupPay.code, 400);
    assert.match(dupPay.body.message, /reference number/);
  } finally { process.env.NODE_ENV = env; console.error = realErr; }
});

// ------------------------------------------------------------ stale rows
test('a session left open on a previous day does not lock the member out; its time-out is not invented', async () => {
  const old = new Date(Date.now() - 2 * day);
  attendance.push({ _id: nid(), userId: M._id, subjectType: 'member', attendanceType: 'MEMBER', checkIn: old, createdAt: old, openSession: true, dayKey: '2020-01-01' });
  const r = await timeIn();
  assert.equal(r.code, 201);
  const stale = attendance.find((a) => a.dayKey === '2020-01-01');
  assert.equal(stale.checkOut, undefined, 'no fabricated time-out');
  assert.equal(stale.missedCheckOut, true);
  assert.equal(stale.openSession, undefined);
  assert.equal(attendance.filter((a) => a.openSession === true).length, 1, 'only today\'s session is open');
});

test('a legacy row from before this change (no openSession flag) still counts as open today', async () => {
  const now = new Date();
  attendance.push({ _id: nid(), userId: M._id, subjectType: 'member', attendanceType: 'MEMBER', checkIn: now, createdAt: now, dayKey: 'legacy' });
  assert.equal((await timeIn()).code, 409);
  const o = await timeOut();
  assert.equal(o.code, 200);
  assert.ok(attendance[0].checkOut, 'the legacy row is the one that was closed');
});

// -------------------------------------------------------------- RFID taps
test('RFID: three in/out cycles in a day are three sessions; one deduction', async () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await tap()).action, 'checkin');
    assert.equal((await tap()).action, 'checkout');
  }
  assert.equal(mine().length, 3);
  assert.equal(open().length, 0);
  assert.equal(deductions.length, 1);
  assert.ok(mine().every((a) => a.checkIn && a.checkOut));
});

test('RFID: an accidental double tap (same instant) is one action, not in+out', async () => {
  settle();
  const r = await Promise.allSettled([attendanceService.processScan(UID), attendanceService.processScan(UID)]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(mine().length, 1);
  assert.equal(open().length, 1);
  const rej = r.find((x) => x.status === 'rejected').reason;
  assert.equal(rej.errorType, 'duplicate_signal');
});

test('RFID: a repeated signal right after a tap (inside the debounce window) is the same tap, not a check-out', async () => {
  await tap();
  await assert.rejects(() => attendanceService.processScan(UID), (e) => e.errorType === 'duplicate_signal');
  assert.equal(mine().length, 1);
  assert.equal(open().length, 1, 'still checked in - the repeat did not check out');
});

// ------------------------------------------------------- history & reports
test('member history lists every session, including several on one date, newest first', async () => {
  const userController = require('../controllers/userController');
  await timeIn(); await timeOut(); await timeIn(); await timeOut(); await timeIn();
  subs.forEach((x) => { x.startDate = new Date(Date.now() - 5 * day); });
  Attendance.aggregate = async () => [];
  RFIDCard.findOne = () => ({ then: (ok) => Promise.resolve(null).then(ok) });
  const rows = mine();
  rows.forEach((r, i) => { r.checkIn = new Date(Date.now() + i * 1000); });
  const out = res();
  await userController.getDashboardSummary({ user: { _id: M._id, fullname: M.fullname }, query: {} }, out, (e) => { throw e; });
  const visits = out.body.data.recentVisits;
  assert.equal(visits.length, 3);
  assert.ok(visits.every((v) => v._id));
  assert.deepEqual(visits.map((v) => !!v.checkOut), [false, true, true], 'newest first; the last session is still open');
});
