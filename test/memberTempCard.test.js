// test/memberTempCard.test.js - run with:  npm test
//
// Member temporary-card flow end to end (issue -> tap -> attendance ->
// return -> reuse), against the real service/controller code with the Mongoose
// models replaced by a small in-memory store (same approach as
// visitorFlow.test.js). The store also simulates the unique indexes the models
// declare, so duplicate-assignment / duplicate-attendance paths are exercised.
// It verifies application logic; it does NOT prove real MongoDB semantics, so
// the staging checklist still applies.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.RFID_HASH_SECRET;

const jwt = require('jsonwebtoken');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const TempCardAssignment = require('../models/TempCardAssignment');
const cardLookup = require('../services/rfidCardLookup');

// ---------------------------------------------------------------- fake store
let seq = 0;
const nid = () => String(++seq).padStart(24, '0');
// Ids compare by value, and a populated document compares by its _id (as Mongo does).
const idv = (v) => String(v && v._id ? v._id : v);
const same = (a, b) => idv(a) === idv(b);
const isNil = (v) => v === null || v === undefined;

function matchValue(actual, cond) {
  if (cond === null) return isNil(actual);
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof RegExp)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$ne': return v === null ? !isNil(actual) : !same(actual, v);
        case '$in': return v.some((x) => same(actual, x));
        case '$exists': return v ? actual !== undefined : actual === undefined;
        case '$lt': return actual != null && actual < v;
        case '$lte': return actual != null && actual <= v;
        case '$gte': return actual != null && actual >= v;
        case '$regex': return new RegExp(v, cond.$options || '').test(String(actual));
        case '$options': return true;
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
const dup = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

function install(Model, store, defaults = {}, uniqueCheck = () => {}) {
  const wrap = (d) => (d ? Object.assign(d, {
    toObject() { const { toObject, populate, save, ...rest } = this; return { ...rest }; },
    async populate() { return this; },
    async save() { return this; },
  }) : d);
  const query = (fn) => ({
    _sort: null,
    limit() { return this; }, select() { return this; }, lean() { return this; }, populate() { return this; },
    sort(s) { this._sort = s; return this; },
    then(res, rej) { return Promise.resolve(fn(this._sort)).then(res, rej); },
  });
  const sorted = (rows, sort) => {
    if (!sort) return rows;
    const [k, dir] = Object.entries(sort)[0];
    return [...rows].sort((a, b) => ((a[k] > b[k]) - (a[k] < b[k])) * dir);
  };
  Model.create = async (data) => {
    const d = wrap({ _id: nid(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...data });
    uniqueCheck(d, store);
    store.push(d);
    return d;
  };
  Model.findOne = (f) => query((s) => sorted(store.filter((d) => matches(d, f)), s)[0] || null);
  Model.find = (f = {}) => query((s) => sorted(store.filter((d) => matches(d, f)), s));
  Model.findById = (id) => query(() => store.find((d) => same(d._id, id)) || null);
  Model.findOneAndUpdate = async (f, u) => {
    const d = store.find((x) => matches(x, f));
    if (!d) return null;
    applyUpdate(d, u);
    return d;
  };
  Model.updateOne = async (f, u) => { const d = store.find((x) => matches(x, f)); if (d) applyUpdate(d, u); return { modifiedCount: d ? 1 : 0 }; };
  Model.updateMany = async (f, u) => { const rows = store.filter((x) => matches(x, f)); rows.forEach((d) => applyUpdate(d, u)); return { modifiedCount: rows.length }; };
}

const cards = []; const attendance = []; const users = []; const subs = []; const assignments = [];
const holding = (d) => d.holdsCard !== false; // schema default is true
install(RFIDCard, cards, { active: true, cardType: 'MEMBER' }, (d, s) => {
  if (s.some((x) => x.cardId === d.cardId)) throw dup();
});
install(Attendance, attendance, {}, (d, s) => {
  // mirrors the partial unique index { userId, dayKey } where attendanceType MEMBER
  if (d.attendanceType === 'MEMBER' && typeof d.dayKey === 'string'
      && s.some((x) => x.attendanceType === 'MEMBER' && same(x.userId, d.userId) && x.dayKey === d.dayKey)) throw dup();
});
install(User, users, { isActive: true, role: 'user' });
install(Subscription, subs);
install(TempCardAssignment, assignments, { status: 'ACTIVE', holdsCard: true }, (d, s) => {
  // mirrors one_active_per_member and one_holder_per_card
  if (d.status === 'ACTIVE' && s.some((x) => x.status === 'ACTIVE' && same(x.memberId, d.memberId))) throw dup();
  if (holding(d) && s.some((x) => holding(x) && same(x.tempCardId, d.tempCardId))) throw dup();
});
AuditLog.create = async () => ({});
cardLookup.findByUid = (uid) => ({
  populate() { return this; },
  then(res, rej) { return Promise.resolve(cards.find((c) => c.cardId === uid) || null).then(res, rej); },
});
const socketUtil = require('../utils/socket');
socketUtil.emitToAdmins = () => {}; socketUtil.emitToUser = () => {};
const scanErrors = [];
const subscriptionService = require('../services/subscriptionService');
const deductions = [];
subscriptionService.recordAttendanceSession = async (userId) => { deductions.push(String(userId)); };

const attendanceService = require('../services/attendanceService');
const tempCardService = require('../services/tempCardService');
const tempCtl = require('../controllers/tempCardController');
const rfid = require('../controllers/rfidController');

// ------------------------------------------------------------------- helpers
const UID_ORIG = 'AAAA1111', UID_ORIG2 = 'BBBB2222', UID_ORIG3 = 'CCCC3333', UID_SPARE = 'D0D0D0D0', UID_SPARE2 = 'E1E1E1E1';
const admin = { _id: 'admin1', role: 'admin' };
const day = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const call = async (fn, req) => { const r = res(); await fn({ user: admin, body: {}, query: {}, params: {}, ...req }, r, (e) => { throw e; }); return r; };
const issue = (memberId, tempCardUid, extra = {}) => call(tempCtl.issueToMember, { body: { memberId, tempCardUid, originalNotPresent: true, ...extra } });
const settle = () => cards.forEach((c) => { if (c.lastScannedAt) c.lastScannedAt = new Date(Date.now() - 60_000); });
const tap = async (uid) => { settle(); return attendanceService.processScan(uid); };
const cardOf = (uid) => cards.find((c) => c.cardId === uid);

function addMember(name, { sub = 'active', cardUid, isActive = true } = {}) {
  const u = { _id: nid(), fullname: name, email: `${name.toLowerCase().replace(/\s/g, '')}@x.test`, role: 'user', isActive };
  users.push(u);
  if (sub === 'active') subs.push({ _id: nid(), userId: u._id, status: 'active', endDate: new Date(Date.now() + 30 * day) });
  if (sub === 'expired') subs.push({ _id: nid(), userId: u._id, status: 'active', endDate: new Date(Date.now() - 2 * day) });
  if (sub === 'inactive') subs.push({ _id: nid(), userId: u._id, status: 'cancelled', endDate: new Date(Date.now() + 30 * day) });
  if (cardUid) cards.push({ _id: nid(), cardId: cardUid, cardType: 'MEMBER', active: true, userId: u, createdAt: new Date() });
  return u;
}

let M1, M2;
test.beforeEach(() => {
  [cards, attendance, users, subs, assignments, deductions].forEach((a) => { a.length = 0; });
  M1 = addMember('Maria Santos', { cardUid: UID_ORIG });
  M2 = addMember('Juan Dela Cruz', { cardUid: UID_ORIG2 });
});

// ------------------------------------------------------------------- issuance
test('issue: creates an ACTIVE assignment; original card untouched; no new member/visitor record', async () => {
  const origBefore = JSON.stringify({ ...cardOf(UID_ORIG), userId: String(M1._id) });
  const usersBefore = users.length;
  const r = await issue(M1._id, UID_SPARE);
  assert.equal(r.code, 201);
  assert.equal(r.body.data.status, 'ACTIVE');
  assert.equal(r.body.data.originalVerifiedBy, 'database-record');
  assert.equal(JSON.stringify({ ...cardOf(UID_ORIG), userId: String(M1._id) }), origBefore);
  assert.equal(users.length, usersBefore);
  assert.equal(attendance.length, 0);
  assert.equal(deductions.length, 0, 'issuing must not deduct');
  assert.ok(cardOf(UID_SPARE).memberAssignmentId);
  assert.equal(cardOf(UID_SPARE).cardType, 'TEMPORARY');
  // expires at the end of the Manila day
  assert.ok(new Date(r.body.data.expiresAt) > new Date());
  assert.ok(new Date(r.body.data.expiresAt) - new Date() < day);
});

test('issue: a scanned original card is verified against the member; a wrong member card is refused', async () => {
  const ok = await issue(M1._id, UID_SPARE, { originalNotPresent: undefined, originalCardUid: UID_ORIG });
  assert.equal(ok.code, 201);
  assert.equal(ok.body.data.originalVerifiedBy, 'scanned');

  const bad = await issue(M2._id, UID_SPARE2, { originalNotPresent: undefined, originalCardUid: UID_ORIG });
  assert.equal(bad.code, 409);
  assert.equal(bad.body.errorType, 'original_card_mismatch');
  assert.equal(cardOf(UID_SPARE2), undefined, 'a refused issue must not register the spare');
});

test('issue: needs the original scanned OR an explicit "not present" confirmation', async () => {
  const r = await issue(M1._id, UID_SPARE, { originalNotPresent: undefined });
  assert.equal(r.code, 400);
  assert.equal(r.body.errorType, 'original_not_verified');
});

test('issue: expired / inactive / no-subscription / deactivated members are refused and nothing is created', async () => {
  const cases = [
    [addMember('Exp Ired', { sub: 'expired', cardUid: 'F001F001' }), 'subscription_expired'],
    [addMember('In Active', { sub: 'inactive', cardUid: 'F002F002' }), 'subscription_inactive'],
    [addMember('No Sub', { sub: 'none', cardUid: 'F003F003' }), 'no_subscription'],
    [addMember('Dead Acct', { isActive: false, cardUid: 'F004F004' }), 'member_inactive'],
  ];
  for (const [m, type] of cases) {
    const r = await issue(m._id, UID_SPARE);
    assert.equal(r.code, 409, type);
    assert.equal(r.body.errorType, type);
  }
  assert.equal(assignments.length, 0);
  assert.equal(cardOf(UID_SPARE), undefined);
});

test('issue: refused when the member already has a visit today (checked in, or completed)', async () => {
  await tap(UID_ORIG); // inside
  assert.equal((await issue(M1._id, UID_SPARE)).body.errorType, 'attendance_today_exists');
  await tap(UID_ORIG); // checked out
  const r = await issue(M1._id, UID_SPARE);
  assert.equal(r.code, 409);
  assert.match(r.body.message, /already completed/);
});

test('issue: refused when the card is a member card, lent to someone, or an active visitor pass', async () => {
  assert.equal((await issue(M1._id, UID_ORIG2)).body.errorType, 'not_a_spare_card');

  assert.equal((await issue(M1._id, UID_SPARE)).code, 201);
  assert.equal((await issue(M2._id, UID_SPARE)).body.errorType, 'card_unavailable');

  await new Promise((r) => setTimeout(r, 3));
  const v = await call(rfid.issueTemporaryCard, { body: { cardId: UID_SPARE2, visitorName: 'Ana' } });
  assert.equal(v.code, 201);
  assert.equal((await issue(M2._id, UID_SPARE2)).body.errorType, 'card_unavailable');
});

test('issue: a member cannot hold two active temporary cards', async () => {
  assert.equal((await issue(M1._id, UID_SPARE)).code, 201);
  const r = await issue(M1._id, UID_SPARE2);
  assert.equal(r.code, 409);
  assert.equal(r.body.errorType, 'member_has_active_loan');
  assert.equal(cardOf(UID_SPARE2), undefined);
});

test('issue: untrusted payloads are rejected (operator objects, bad ids, bad UIDs)', async () => {
  assert.equal((await issue({ $ne: null }, UID_SPARE)).code, 400);
  assert.equal((await issue('not-an-id', UID_SPARE)).code, 400);
  assert.equal((await issue(M1._id, { $ne: null })).code, 400);
  assert.equal((await issue(M1._id, 'zz')).code, 400);
  assert.equal((await issue(M1._id, UID_SPARE, { originalNotPresent: undefined, originalCardUid: { $ne: null } })).code, 400);
  assert.equal(assignments.length, 0);
});

// ------------------------------------------------------------ tap resolution
test('tap: the spare card resolves to the existing member; subscription deducted exactly once; attendance is MEMBER', async () => {
  await issue(M1._id, UID_SPARE);
  const out = await tap(UID_SPARE);
  assert.equal(out.action, 'checkin');
  assert.equal(String(out.user._id), String(M1._id));
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].attendanceType, 'MEMBER');
  assert.equal(String(attendance[0].userId), String(M1._id));
  assert.ok(attendance[0].dayKey);
  assert.deepEqual(deductions, [String(M1._id)]);
  assert.equal(users.length, 2, 'no member/visitor created');
  assert.equal(attendance.filter((a) => a.attendanceType === 'VISITOR').length, 0);
});

test('tap: original + temporary on the same day share ONE attendance row and ONE deduction', async () => {
  await issue(M1._id, UID_SPARE);
  await tap(UID_SPARE);                       // check-in via spare
  const out = await tap(UID_ORIG);            // original card -> same row, checkout
  assert.equal(out.action, 'checkout');
  assert.equal(attendance.length, 1);
  assert.ok(attendance[0].checkOut);
  assert.equal(deductions.length, 1);
  await assert.rejects(() => tap(UID_SPARE), (e) => e.errorType === 'daily_attendance_completed');
  await assert.rejects(() => tap(UID_ORIG), (e) => e.errorType === 'daily_attendance_completed');
  assert.equal(attendance.length, 1);
  assert.equal(deductions.length, 1);
});

test('tap: expired subscription still blocks entry on a spare card (rules are the member rules)', async () => {
  await issue(M1._id, UID_SPARE);
  subs.find((s) => same(s.userId, M1._id)).endDate = new Date(Date.now() - 1000);
  await assert.rejects(() => tap(UID_SPARE), (e) => e.errorType === 'subscription_expired');
  assert.equal(attendance.length, 0);
  assert.equal(deductions.length, 0);
});

test('tap: concurrent taps on original + temporary create one attendance row and one deduction', async () => {
  await issue(M1._id, UID_SPARE);
  settle();
  const results = await Promise.allSettled([attendanceService.processScan(UID_SPARE), attendanceService.processScan(UID_ORIG)]);
  assert.equal(attendance.length, 1, 'exactly one row');
  assert.equal(deductions.length, 1, 'exactly one deduction');
  assert.equal(results.filter((r) => r.status === 'fulfilled').length >= 1, true);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.errorType, 'duplicate_scan');
});

test('tap: a double tap of the same card is stopped by the atomic cooldown', async () => {
  await issue(M1._id, UID_SPARE);
  settle();
  const results = await Promise.allSettled([attendanceService.processScan(UID_SPARE), attendanceService.processScan(UID_SPARE)]);
  assert.equal(attendance.length, 1);
  assert.equal(deductions.length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
});

// ------------------------------------------------------------- expiry/return
test('expiry: enforced on the server at tap time; the card stays held until returned', async () => {
  const r = await issue(M1._id, UID_SPARE);
  assignments[0].expiresAt = new Date(Date.now() - 1000); // the day ended
  await assert.rejects(() => tap(UID_SPARE), (e) => e.errorType === 'temp_card_expired');
  assert.equal(attendance.length, 0);
  assert.equal(assignments[0].status, 'EXPIRED');

  // still held: cannot be lent again, member cannot be issued another yet
  assert.equal((await issue(M2._id, UID_SPARE)).body.errorType, 'card_unavailable');
  assert.equal((await issue(M1._id, UID_SPARE2)).body.errorType, 'member_has_active_loan');
  const inv = await call(tempCtl.inventory, {});
  assert.equal(inv.body.data.find((c) => c.cardRef === UID_SPARE).state, 'EXPIRED');

  // staff mark it returned -> free again
  const ret = await call(tempCtl.returnCard, { body: { id: cardOf(UID_SPARE)._id } });
  assert.equal(ret.code, 200);
  assert.equal(ret.body.data.status, 'RETURNED');
  assert.equal((await issue(M2._id, UID_SPARE)).code, 201);
});

test('return: assignment ended, card AVAILABLE, returned tap denied, original card still works, history kept', async () => {
  const issued = await issue(M1._id, UID_SPARE);
  const ret = await call(tempCtl.returnCard, { body: { uid: UID_SPARE } });
  assert.equal(ret.code, 200);
  assert.equal(ret.body.data.status, 'RETURNED');
  assert.ok(ret.body.data.returnedAt);
  assert.equal(assignments.length, 1, 'history is kept');
  assert.equal(assignments[0].returnedBy, 'admin1');
  assert.equal(deductions.length, 0, 'returning must not deduct');

  const inv = await call(tempCtl.inventory, {});
  const row = inv.body.data.find((c) => c.cardRef === UID_SPARE);
  assert.equal(row.state, 'AVAILABLE');
  assert.equal(row.lastOutcome, 'RETURNED');

  await assert.rejects(() => tap(UID_SPARE), (e) => e.errorType === 'temp_card_not_assigned');
  assert.equal(attendance.length, 0);

  const orig = await tap(UID_ORIG);
  assert.equal(orig.action, 'checkin');
  assert.equal(String(orig.user._id), String(M1._id));

  // returning twice is refused, not silently repeated
  const again = await call(tempCtl.returnCard, { body: { id: cardOf(UID_SPARE)._id } });
  assert.equal(again.body.data.alreadyAvailable, true);
  assert.ok(issued.body.data._id);
});

test('reuse: a returned card can be lent to another member or issued as a visitor pass; visits stay separate', async () => {
  await issue(M1._id, UID_SPARE);
  await tap(UID_SPARE);
  await tap(UID_ORIG); // M1 done for the day
  await call(tempCtl.returnCard, { body: { uid: UID_SPARE } });

  assert.equal((await issue(M2._id, UID_SPARE)).code, 201);
  await call(tempCtl.returnCard, { body: { uid: UID_SPARE } });

  await sleep(3);
  const v = await call(rfid.issueTemporaryCard, { body: { cardId: UID_SPARE, visitorName: 'Ana Reyes' } });
  assert.equal(v.code, 201);
  const before = deductions.length;
  const out = await tap(UID_SPARE);
  assert.equal(out.action, 'checkin');
  assert.equal(attendance[attendance.length - 1].attendanceType, 'VISITOR');
  assert.equal(attendance[attendance.length - 1].userId, undefined);
  assert.equal(deductions.length, before, 'visitor attendance never deducts a member session');
});

test('return: an unused visitor pass can be returned; a visitor who is inside cannot', async () => {
  await sleep(3);
  await call(rfid.issueTemporaryCard, { body: { cardId: UID_SPARE, visitorName: 'Ana' } });
  await sleep(3);
  await call(rfid.issueTemporaryCard, { body: { cardId: UID_SPARE2, visitorName: 'Ben' } });
  await tap(UID_SPARE2); // Ben is inside
  const inside = await call(tempCtl.returnCard, { body: { uid: UID_SPARE2 } });
  assert.equal(inside.code, 409);
  assert.equal(inside.body.errorType, 'visitor_inside');
  const unused = await call(tempCtl.returnCard, { body: { uid: UID_SPARE } });
  assert.equal(unused.code, 200);
  assert.equal(cardOf(UID_SPARE).active, false);
});

test('revoke: needs a reason, stops the card immediately, frees it, keeps history', async () => {
  await issue(M1._id, UID_SPARE);
  const id = String(assignments[0]._id); // route params are always strings
  assert.equal((await call(tempCtl.revokeAssignment, { params: { id }, body: {} })).code, 400);
  const r = await call(tempCtl.revokeAssignment, { params: { id }, body: { reason: 'Card lost' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.data.status, 'REVOKED');
  assert.equal(r.body.data.revokedReason, 'Card lost');
  await assert.rejects(() => tap(UID_SPARE), (e) => e.errorType === 'temp_card_not_assigned');
  assert.equal(assignments.length, 1);
  assert.equal((await call(tempCtl.revokeAssignment, { params: { id }, body: { reason: 'again' } })).code, 409);
});

test('a never-issued or returned spare card grants nothing (CARD NOT ASSIGNED, not a visitor error)', async () => {
  cards.push({ _id: nid(), cardId: UID_SPARE2, cardType: 'TEMPORARY', active: true, createdAt: new Date() });
  await assert.rejects(() => tap(UID_SPARE2), (e) => e.errorType === 'temp_card_not_assigned' && e.statusCode === 403);
  assert.equal(attendance.length, 0);
});

// -------------------------------------------------------------- concurrency
test('concurrency: two admins lending the SAME card to different members -> exactly one wins', async () => {
  const [a, b] = await Promise.all([issue(M1._id, UID_SPARE), issue(M2._id, UID_SPARE)]);
  assert.deepEqual([a.code, b.code].sort(), [201, 409]);
  assert.equal(assignments.filter((x) => x.status === 'ACTIVE').length, 1);
});

test('concurrency: two cards issued to the SAME member at once -> exactly one wins', async () => {
  const [a, b] = await Promise.all([issue(M1._id, UID_SPARE), issue(M1._id, UID_SPARE2)]);
  assert.deepEqual([a.code, b.code].sort(), [201, 409]);
  assert.equal(assignments.filter((x) => x.status === 'ACTIVE').length, 1);
});

test('concurrency: a visitor issue and a member loan racing for one blank card -> exactly one wins', async () => {
  cards.push({ _id: nid(), cardId: UID_SPARE, cardType: 'TEMPORARY', active: true, createdAt: new Date() });
  const [m, v] = await Promise.all([
    issue(M1._id, UID_SPARE),
    call(rfid.issueTemporaryCard, { body: { cardId: UID_SPARE, visitorName: 'Ana' } }),
  ]);
  assert.deepEqual([m.code, v.code].sort(), [201, 409]);
  const c = cardOf(UID_SPARE);
  assert.equal(!!c.memberAssignmentId && !!c.visitorName, false, 'card is never both');
});

// ----------------------------------------------------------------- listings
test('visitor list excludes member loans and blank spares; inventory shows everything', async () => {
  await issue(M1._id, UID_SPARE);
  await sleep(3);
  await call(rfid.issueTemporaryCard, { body: { cardId: UID_SPARE2, visitorName: 'Ana' } });
  const list = await call(rfid.listTemporaryCards, { query: {} });
  assert.deepEqual(list.body.data.map((p) => p.cardId), [UID_SPARE2]);
  const inv = await call(tempCtl.inventory, {});
  assert.equal(inv.body.data.length, 2);
  assert.deepEqual(inv.body.data.map((c) => c.type).sort(), ['DAY_VISITOR', 'MEMBER_TEMP']);
  // the visitor revoke endpoint refuses a member loan
  const rv = await call(rfid.revokeTemporaryCard, { params: { id: cardOf(UID_SPARE)._id } });
  assert.equal(rv.code, 409);
});

test('member search: shows eligibility, registered card and loan state; ignores short/odd queries', async () => {
  addMember('Exp Ired', { sub: 'expired', cardUid: 'F001F001' });
  const r = await call(tempCtl.searchMembers, { query: { search: 'mar' } });
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].eligible, true);
  assert.equal(r.body.data[0].hasRegisteredCard, true);
  const e = await call(tempCtl.searchMembers, { query: { search: 'exp ired' } });
  assert.equal(e.body.data[0].eligible, false);
  assert.match(e.body.data[0].ineligibleReason, /expired/i);
  assert.deepEqual((await call(tempCtl.searchMembers, { query: { search: 'm' } })).body.data, []);
  assert.deepEqual((await call(tempCtl.searchMembers, { query: { search: { $ne: null } } })).body.data, []);
});

test('self-heal: a card write lost after return is repaired by the next inventory read', async () => {
  await issue(M1._id, UID_SPARE);
  assignments[0].status = 'RETURNED'; assignments[0].holdsCard = false; // assignment closed, card still points at it
  assert.ok(cardOf(UID_SPARE).memberAssignmentId);
  await call(tempCtl.inventory, {});
  assert.equal(cardOf(UID_SPARE).memberAssignmentId, undefined);
});

// ------------------------------------------------------- permissions (HTTP)
test('permissions: unauthenticated and non-admin callers cannot issue, return or revoke', async () => {
  const express = require('express');
  const router = require('../routes/rfidRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/rfid', router);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const { port } = server.address();
  const req = (method, path, token, body) => new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } },
      (resp) => { let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => resolve(resp.statusCode)); });
    r.on('error', reject);
    r.end(method === 'GET' ? undefined : JSON.stringify(body || {}));
  });
  try {
    const memberToken = jwt.sign({ id: M1._id, tokenVersion: 0 }, process.env.JWT_SECRET);
    const targets = [
      ['POST', '/api/rfid/temporary/member-assignments'],
      ['POST', '/api/rfid/temporary/return'],
      ['POST', '/api/rfid/temporary/member-assignments/x/revoke'],
      ['GET', '/api/rfid/temporary/inventory'],
      ['GET', '/api/rfid/temporary/members?search=ma'],
    ];
    for (const [m, p] of targets) {
      assert.equal(await req(m, p, null), 401, `${m} ${p} without token`);
      assert.equal(await req(m, p, memberToken), 403, `${m} ${p} as a member`);
    }
    assert.equal(assignments.length, 0);
  } finally {
    server.close();
  }
});
