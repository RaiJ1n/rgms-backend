// tests/visitorFlow.test.js — run with:  node --test tests/
//
// Exercises the visitor-pass lifecycle end to end (RFID tap -> attendance ->
// pass status -> card availability -> re-issue) WITHOUT a database: the Mongoose
// models are replaced by a tiny in-memory store that supports just the query
// operators these code paths use ($or, $ne, $exists, $lt, $gte, null-match,
// $set, $unset). It verifies the application logic; it does not prove real
// MongoDB semantics, so run the manual checklist against staging as well.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
delete process.env.RFID_HASH_SECRET;

const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const AuditLog = require('../models/AuditLog');
const cardLookup = require('../services/rfidCardLookup');

// ---------------------------------------------------------------- fake store
let seq = 0;
const nid = () => String(++seq).padStart(24, '0');
const same = (a, b) => String(a) === String(b);

function matchValue(actual, cond) {
  if (cond === null) return actual === null || actual === undefined;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$ne': return v === null ? !(actual === null || actual === undefined) : !same(actual, v);
        case '$exists': return v ? actual !== undefined : actual === undefined;
        case '$lt': return actual != null && actual < v;
        case '$gte': return actual != null && actual >= v;
        case '$lte': return actual != null && actual <= v;
        default: throw new Error(`fake store: unsupported operator ${op}`);
      }
    });
  }
  return cond instanceof Date ? +actual === +cond : same(actual, cond);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    return matchValue(doc[k], cond);
  });
}
function applyUpdate(doc, update) {
  Object.entries(update.$set || {}).forEach(([k, v]) => { doc[k] = v; });
  Object.keys(update.$unset || {}).forEach((k) => { delete doc[k]; });
}
function install(Model, store, defaults = {}) {
  const wrap = (d) => (d ? Object.assign(d, {
    toObject() { const { toObject, populate, save, ...rest } = this; return { ...rest }; },
    async populate() { return this; },
    async save() { return this; },
  }) : d);
  const query = (fn) => {
    const q = { limit() { return this; }, _sort: null, then(res, rej) { return Promise.resolve(fn(this._sort)).then(res, rej); },
      sort(s) { this._sort = s; return this; }, lean() { return this; }, populate() { return this; } };
    return q;
  };
  Model.create = async (data) => { const d = wrap({ _id: nid(), createdAt: new Date(), ...defaults, ...data }); store.push(d); return d; };
  Model.findOne = (f) => query((sort) => {
    let rows = store.filter((d) => matches(d, f));
    if (sort) { const [k, dir] = Object.entries(sort)[0]; rows = rows.sort((a, b) => (a[k] - b[k]) * dir); }
    return rows[0] || null;
  });
  Model.find = (f) => query((sort) => {
    let rows = store.filter((d) => matches(d, f));
    if (sort) { const [k, dir] = Object.entries(sort)[0]; rows = rows.sort((a, b) => (a[k] - b[k]) * dir); }
    return rows;
  });
  Model.findById = async (id) => store.find((d) => same(d._id, id)) || null;
  Model.findOneAndUpdate = async (f, u) => { const d = store.find((x) => matches(x, f)); if (!d) return null; applyUpdate(d, u); return d; };
  Model.updateOne = async (f, u) => { const d = store.find((x) => matches(x, f)); if (d) applyUpdate(d, u); return { modifiedCount: d ? 1 : 0 }; };
}

const cards = [];
const attendance = [];
install(RFIDCard, cards, { active: true, cardType: 'MEMBER' });
install(Attendance, attendance);
AuditLog.create = async () => ({});
cardLookup.findByUid = (uid) => ({
  populate() { return this; },
  then(res, rej) { return Promise.resolve(cards.find((c) => c.cardId === uid) || null).then(res, rej); },
});
// Plain socket util: no io server in tests.
const socketUtil = require('../utils/socket');
socketUtil.emitToAdmins = () => {};
socketUtil.emitToUser = () => {};

const attendanceService = require('../services/attendanceService');
const passes = require('../services/visitorPassService');
const rfid = require('../controllers/rfidController');
const { startOfLocalDay, endOfLocalDay } = require('../utils/localDate');

// --------------------------------------------------------------- test helpers
const UID_A = 'A1B2C3D4';
const UID_B = 'E5F6A7B8';
const admin = { _id: 'admin1' };
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const run = async (fn) => { const r = res(); await fn(r); return r; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const issue = async (cardId, visitorName) => { await sleep(3); return issueNow(cardId, visitorName); };
const issueNow = (cardId, visitorName) => run((r) =>
  rfid.issueTemporaryCard({ body: { cardId, visitorName }, user: admin }, r, (e) => { throw e; }));
// The 10s duplicate-scan guard is by design; move lastScannedAt back instead of sleeping.
const settle = () => cards.forEach((c) => { if (c.lastScannedAt) c.lastScannedAt = new Date(Date.now() - 60_000); });
const tap = async (uid) => { settle(); return attendanceService.processScan(uid); };
const cardOf = (uid) => cards.find((c) => c.cardId === uid);

test.beforeEach(() => { cards.length = 0; attendance.length = 0; });

test('check-in -> ACTIVE; attendance is VISITOR; card is not available', async () => {
  assert.equal((await issue(UID_A, 'Ana')).code, 201);
  assert.equal(passes.passStatus(cardOf(UID_A)), 'PENDING');

  const out = await tap(UID_A);
  assert.equal(out.action, 'checkin');
  assert.equal(attendance[0].attendanceType, 'VISITOR');
  assert.equal(passes.passStatus(cardOf(UID_A)), 'ACTIVE');
  assert.equal(passes.presentPass(cardOf(UID_A)).cardAvailable, false);
});

test('check-out -> CHECKED_OUT, attendance closed, card AVAILABLE (never reverts to ACTIVE)', async () => {
  await issue(UID_A, 'Ana');
  await tap(UID_A);
  const out = await tap(UID_A);
  assert.equal(out.action, 'checkout');
  assert.ok(attendance[0].checkOut);

  const pass = passes.presentPass(cardOf(UID_A));
  assert.equal(pass.status, 'CHECKED_OUT');
  assert.equal(pass.cardAvailable, true);
  assert.ok(pass.checkedOutAt);

  // Re-reading the list (refresh / re-login) gives the same answer.
  const list = await run((r) => rfid.listTemporaryCards({ query: {} }, r, (e) => { throw e; }));
  assert.equal(list.body.data[0].status, 'CHECKED_OUT');
});

test('a finished visit cannot be started again on the same pass', async () => {
  await issue(UID_A, 'Ana');
  await tap(UID_A);
  await tap(UID_A);
  await assert.rejects(() => tap(UID_A), (e) => e.errorType === 'daily_attendance_completed');
  assert.equal(attendance.length, 1);
});

test('re-issue is REJECTED while the visitor is still checked in', async () => {
  await issue(UID_A, 'Visitor A');
  await tap(UID_A);
  const r = await issue(UID_A, 'Visitor B');
  assert.equal(r.code, 409);
  assert.match(r.body.message, /currently in use/);
  assert.equal(cardOf(UID_A).visitorName, 'Visitor A');
});

test('re-issue is REJECTED while the pass is issued but not yet used (PENDING)', async () => {
  await issue(UID_A, 'Visitor A');
  assert.equal((await issue(UID_A, 'Visitor B')).code, 409);
});

test('after checkout the same card can be assigned to the next visitor, who gets a clean visit', async () => {
  await issue(UID_A, 'Visitor A');
  await tap(UID_A);
  await tap(UID_A);

  const r = await issue(UID_A, 'Visitor B');
  assert.equal(r.code, 201);
  assert.equal(r.body.data.status, 'PENDING');
  assert.equal(r.body.data.checkedOutAt, null);

  const inB = await tap(UID_A);
  assert.equal(inB.action, 'checkin');
  assert.equal(attendance.length, 2);
  assert.equal(attendance[1].guestName, 'Visitor B');
  assert.equal(passes.passStatus(cardOf(UID_A)), 'ACTIVE');
});

test('atomic claim: a second admin racing for a card that just got taken is refused', async () => {
  await issue(UID_A, 'Visitor A');
  await tap(UID_A);
  await tap(UID_A); // available
  await sleep(3);
  const [x, y] = await Promise.all([issueNow(UID_A, 'Visitor B'), issueNow(UID_A, 'Visitor C')]);
  assert.deepEqual([x.code, y.code].sort(), [201, 409]);
});

test('a visitor still inside can check out after validUntil; card is then released', async () => {
  await issue(UID_A, 'Ana');
  await tap(UID_A);
  cardOf(UID_A).validUntil = new Date(Date.now() - 1000); // day rolled over while inside
  assert.equal(passes.passStatus(cardOf(UID_A)), 'EXPIRED');
  const out = await tap(UID_A);
  assert.equal(out.action, 'checkout');
  assert.equal(passes.passStatus(cardOf(UID_A)), 'CHECKED_OUT');
});

test('expiry alone does not hand a LIVE card away: PENDING/ACTIVE passes are not available', async () => {
  await issue(UID_A, 'Ana');
  assert.equal(passes.isCardAvailable(cardOf(UID_A)), false);
  await tap(UID_A);
  assert.equal(passes.isCardAvailable(cardOf(UID_A)), false);
});

test('revoked pass is REVOKED (highest precedence) and its card is available', async () => {
  await issue(UID_A, 'Ana');
  const id = cardOf(UID_A)._id;
  const r = await run((x) => rfid.revokeTemporaryCard({ params: { id }, user: admin }, x, (e) => { throw e; }));
  assert.equal(r.body.data.status, 'REVOKED');
  assert.equal(r.body.data.cardAvailable, true);
});

test('self-heal: attendance closed but card write lost -> reconcile repairs the card', async () => {
  await issue(UID_A, 'Ana');
  await tap(UID_A);
  const c = cardOf(UID_A);
  attendance[0].checkOut = new Date();   // checkout happened...
  delete c.checkedOutAt;                  // ...but the card write was lost
  assert.equal(passes.passStatus(c), 'ACTIVE');
  await passes.reconcilePass(c);
  assert.equal(passes.passStatus(c), 'CHECKED_OUT');
  assert.equal((await issue(UID_A, 'Visitor B')).code, 201); // and the issue path heals too
});

test('manual admin attendance for a visitor uses the same rules', async () => {
  await issue(UID_A, 'Ana');
  const id = cardOf(UID_A)._id;
  const inn = await attendanceService.manualVisitorAttendance({ passId: id, action: 'checkin', adminId: 'admin1' });
  assert.equal(inn.attendance.attendanceType, 'VISITOR');
  assert.equal(passes.passStatus(cardOf(UID_A)), 'ACTIVE');
  await assert.rejects(() => attendanceService.manualVisitorAttendance({ passId: id, action: 'checkin' }), /already checked in/);
  await attendanceService.manualVisitorAttendance({ passId: id, action: 'checkout', adminId: 'admin1' });
  assert.equal(passes.passStatus(cardOf(UID_A)), 'CHECKED_OUT');
  await assert.rejects(() => attendanceService.manualVisitorAttendance({ passId: id, action: 'checkin' }), /already checked out/);
  await assert.rejects(() => attendanceService.manualVisitorAttendance({ passId: id, action: 'checkout' }), /not currently checked in/);
});

test('manual visitor attendance is refused for revoked and not-yet-valid passes', async () => {
  await issue(UID_A, 'Ana');
  const c = cardOf(UID_A);
  c.validFrom = new Date(Date.now() + 86_400_000); c.validUntil = new Date(Date.now() + 2 * 86_400_000);
  await assert.rejects(() => attendanceService.manualVisitorAttendance({ passId: c._id, action: 'checkin' }), /not valid yet/);
  c.active = false;
  await assert.rejects(() => attendanceService.manualVisitorAttendance({ passId: c._id, action: 'checkin' }), /revoked/);
});

test('attendanceType fallback for legacy rows', () => {
  const t = (d, card) => Attendance.resolveType(d, card);
  assert.equal(t({ userId: 'u' }), 'MEMBER');
  assert.equal(t({ coachId: 'c', subjectType: 'employee' }), 'EMPLOYEE');
  assert.equal(t({ guestName: 'x', notes: 'Visitor pass' }), 'VISITOR');
  assert.equal(t({ guestName: 'x' }, { cardType: 'TEMPORARY' }), 'VISITOR');
  assert.equal(t({ guestName: 'walk-in' }), 'GUEST');
  assert.equal(t({ attendanceType: 'VISITOR', userId: 'u' }), 'VISITOR');
});

test('window helpers sanity (Manila day)', () => {
  assert.ok(endOfLocalDay() > startOfLocalDay());
});
