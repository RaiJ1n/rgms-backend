// test/phase5Flows.test.js - end-to-end attendance + deduction flows with the
// REAL subscriptionService (the older suites mock the deduction). UNIT/FLOW
// tests over the in-memory model store with a mocked clock: they prove the
// application logic, NOT MongoDB behaviour (see dailyDeduction.mongo.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';
delete process.env.RFID_DEBOUNCE_MS;
delete process.env.RFID_DEBOUNCE_SKEW_MS;
delete process.env.RFID_HASH_SECRET;

const { install, dup, nid, same } = require('./helpers/fakeStore');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const TempCardAssignment = require('../models/TempCardAssignment');
const cardLookup = require('../services/rfidCardLookup');

const cards = []; const attendance = []; const users = []; const subs = []; const assignments = [];
install(RFIDCard, cards, { active: true, cardType: 'MEMBER' }, (d, s) => { if (s.some((x) => x.cardId === d.cardId)) throw dup(); });
install(Attendance, attendance, {}, (d, s) => {
  if (d.openSession === true && s.some((x) => x.openSession === true && same(x.userId, d.userId))) throw dup();
  if (typeof d.requestId === 'string' && s.some((x) => x.requestId === d.requestId)) throw dup();
  if (typeof d.checkOutRequestId === 'string' && s.some((x) => x.checkOutRequestId === d.checkOutRequestId)) throw dup();
});
install(User, users, { isActive: true, role: 'user' });
install(Subscription, subs);
install(TempCardAssignment, assignments, { status: 'ACTIVE', holdsCard: true });
AuditLog.create = async () => ({});
cardLookup.findByUid = (uid) => ({
  populate() { return this; },
  then(res, rej) { return Promise.resolve(cards.find((c) => c.cardId === uid) || null).then(res, rej); },
});
const socketUtil = require('../utils/socket');
socketUtil.emitToAdmins = () => {}; socketUtil.emitToUser = () => {};

// REAL deduction service, wrapped only to count calls (never replaced).
const subscriptionService = require('../services/subscriptionService');
let deductionCalls = 0;
const realRecord = subscriptionService.recordAttendanceSession;
subscriptionService.recordAttendanceSession = (...a) => { deductionCalls += 1; return realRecord(...a); };

const attendanceService = require('../services/attendanceService');
const memberAttendance = require('../services/memberAttendanceService');
const rfid = require('../controllers/rfidController');
const scanDedup = require('../services/scanDedup');
const { formatLocalDateLabel } = require('../utils/localDate');

const DAY = 24 * 3600 * 1000;
const START = Date.parse('2026-10-14T03:00:00Z'); // 11:00 Manila
let clock;
const at = (iso) => clock.setTime(Date.parse(iso));
const advance = (ms) => clock.tick(ms);
const scan = (uid, opts) => attendanceService.processScan(uid, opts).then((r) => r.action, (e) => e.errorType);
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

function addMember(name, uid, subDoc = {}) {
  const u = { _id: nid(), fullname: name, email: `${name.toLowerCase().replace(/\s/g, '')}@x.test`, role: 'user', isActive: true };
  users.push(u);
  const sub = { _id: nid(), userId: u._id, status: 'active', planId: { durationValue: 1, durationUnit: 'month' }, endDate: new Date(START + 30 * DAY), sessionsUsed: 0, ...subDoc };
  subs.push(sub);
  if (uid) cards.push({ _id: nid(), cardId: uid, cardType: 'MEMBER', active: true, userId: u, createdAt: new Date() });
  return { u, sub };
}

test.beforeEach((t) => {
  [cards, attendance, users, subs, assignments].forEach((a) => { a.length = 0; });
  deductionCalls = 0;
  scanDedup._reset();
  t.mock.timers.enable({ apis: ['Date'], now: START });
  clock = t.mock.timers;
  clock.setTime = (ms) => { clock.tick(ms - Date.now()); };
});

test('RFID: IN, OUT, IN across several taps deducts exactly once (real service); legacy sub gets its marker', async () => {
  const { sub } = addMember('Maria Santos', 'AAAA1111');
  assert.equal('lastDeductedDayKey' in sub, false);
  const seq = [];
  for (let i = 0; i < 4; i += 1) { seq.push(await scan('AAAA1111')); advance(6000); }
  assert.deepEqual(seq, ['checkin', 'checkout', 'checkin', 'checkout']);
  assert.equal(attendance.length, 2);
  assert.equal(sub.sessionsUsed, 1);
  assert.equal(sub.lastDeductedDayKey, '2026-10-14');
});

test('RFID: a repeat inside the cooldown and a replayed scanId add no row and no deduction', async () => {
  const { sub } = addMember('Maria Santos', 'AAAA1111');
  assert.equal(await scan('AAAA1111', { scanId: 'bridge-scan-0001' }), 'checkin');
  advance(2000);
  assert.equal(await scan('AAAA1111', { scanId: 'bridge-scan-0002' }), 'duplicate_signal');
  advance(1000);
  const replay = await attendanceService.processScan('AAAA1111', { scanId: 'bridge-scan-0001' });
  assert.equal(replay.replayed, true);
  assert.equal(attendance.length, 1);
  assert.equal(sub.sessionsUsed, 1);
});

test('RFID: simultaneous identical taps -> one row, one deduction', async () => {
  const { sub } = addMember('Maria Santos', 'AAAA1111');
  const out = await Promise.all(Array.from({ length: 6 }, (_, i) => scan('AAAA1111', { scanId: `bridge-race-${i}-xxxx` })));
  assert.equal(out.filter((a) => a === 'checkin').length, 1);
  assert.equal(attendance.length, 1);
  assert.equal(sub.sessionsUsed, 1);
});

test('RFID: expired, cancelled and deactivated members are refused and never deduct', async () => {
  const exp = addMember('Expired Ed', 'AAAA0001', { endDate: new Date(START - 2 * DAY) });
  const can = addMember('Cancelled Cy', 'AAAA0002', { status: 'cancelled' });
  const off = addMember('Off Olive', 'AAAA0003'); off.u.isActive = false;
  const none = addMember('NoSub Nia', 'AAAA0004'); subs.splice(subs.indexOf(none.sub), 1);
  assert.equal(await scan('AAAA0001'), 'subscription_expired'); advance(6000);
  assert.equal(await scan('AAAA0002'), 'subscription_inactive'); advance(6000);
  assert.equal(await scan('AAAA0003'), 'member_inactive'); advance(6000);
  assert.equal(await scan('AAAA0004'), 'no_subscription');
  assert.equal(attendance.length, 0);
  assert.equal(deductionCalls, 0, 'the deduction is never even attempted');
  assert.equal(exp.sub.sessionsUsed + can.sub.sessionsUsed + off.sub.sessionsUsed, 0);
});

test('original + temporary card of the same member share sessions and ONE daily deduction', async () => {
  const { u, sub } = addMember('Maria Santos', 'AAAA1111');
  const orig = cards.find((c) => c.cardId === 'AAAA1111');
  const spare = { _id: nid(), cardId: 'D0D0D0D0', cardType: 'TEMPORARY', active: true, createdAt: new Date() };
  const loan = { _id: nid(), memberId: u._id, originalCardId: orig._id, tempCardId: spare._id, status: 'ACTIVE', holdsCard: true, expiresAt: new Date(START + DAY) };
  assignments.push(loan); spare.memberAssignmentId = loan._id; cards.push(spare);

  assert.equal(await scan('D0D0D0D0'), 'checkin'); advance(6000);   // spare: Time-In
  assert.equal(await scan('AAAA1111'), 'checkout'); advance(6000);  // original: Time-Out
  assert.equal(await scan('D0D0D0D0'), 'checkin'); advance(6000);   // spare: second session
  assert.equal(attendance.length, 2);
  assert.ok(attendance.every((a) => a.attendanceType === 'MEMBER' && same(a.userId, u._id)));
  assert.equal(sub.sessionsUsed, 1);
  assert.equal(users.length, 1, 'no member/visitor created by the spare card');
});

test('temporary card past its expiry cannot deduct', async () => {
  const { u, sub } = addMember('Maria Santos', 'AAAA1111');
  const spare = { _id: nid(), cardId: 'D0D0D0D0', cardType: 'TEMPORARY', active: true, createdAt: new Date() };
  const loan = { _id: nid(), memberId: u._id, originalCardId: cards[0]._id, tempCardId: spare._id, status: 'ACTIVE', holdsCard: true, expiresAt: new Date(START - 1000) };
  assignments.push(loan); spare.memberAssignmentId = loan._id; cards.push(spare);
  assert.equal(await scan('D0D0D0D0'), 'temp_card_expired');
  assert.equal(deductionCalls, 0);
  assert.equal(sub.sessionsUsed, 0);
});

test('visitor passes (RFID and manual) create no User or Subscription and never invoke the deduction', async () => {
  const { sub } = addMember('Maria Santos', 'AAAA1111');
  cards.push({ _id: nid(), cardId: 'A1B2C3D4', cardType: 'TEMPORARY', active: true, createdAt: new Date() });
  const r = res();
  await rfid.issueTemporaryCard({ body: { cardId: 'A1B2C3D4', visitorName: 'Ana' }, user: { _id: 'admin1' } }, r, (e) => { throw e; });
  assert.equal(r.code, 201);
  const usersBefore = users.length; const subsBefore = subs.length;

  assert.equal(await scan('A1B2C3D4'), 'checkin'); advance(6000);
  assert.equal(await scan('A1B2C3D4'), 'checkout');
  assert.equal(attendance.filter((a) => a.attendanceType === 'VISITOR').length, 1);

  // a second pass used through the manual admin path
  cards.push({ _id: nid(), cardId: 'E5F6A7B8', cardType: 'TEMPORARY', active: true, createdAt: new Date() });
  const r2 = res();
  await rfid.issueTemporaryCard({ body: { cardId: 'E5F6A7B8', visitorName: 'Ben' }, user: { _id: 'admin1' } }, r2, (e) => { throw e; });
  const pass = cards.find((c) => c.cardId === 'E5F6A7B8');
  await attendanceService.manualVisitorAttendance({ passId: pass._id, action: 'checkin', adminId: 'admin1' });
  await attendanceService.manualVisitorAttendance({ passId: pass._id, action: 'checkout', adminId: 'admin1' });

  assert.equal(deductionCalls, 0);
  assert.equal(users.length, usersBefore);
  assert.equal(subs.length, subsBefore);
  assert.equal(sub.sessionsUsed, 0);
});

test('manual admin Time-In after RFID sessions the same day does not deduct again', async () => {
  const { u, sub } = addMember('Maria Santos', 'AAAA1111');
  await scan('AAAA1111'); advance(6000); await scan('AAAA1111'); advance(6000);
  const manual = await memberAttendance.checkIn({ user: u, now: new Date(), notes: 'Manually recorded by admin' });
  assert.equal(manual.deducted, false);
  assert.equal(attendance.length, 2);
  assert.equal(sub.sessionsUsed, 1);
});

test('Manila midnight: sessions before and after 00:00 Manila are different days (one deduction each)', async () => {
  const { sub } = addMember('Maria Santos', 'AAAA1111');
  at('2026-10-14T15:59:30Z');                       // 23:59:30 Manila, 14 Oct
  assert.equal(await scan('AAAA1111'), 'checkin');
  advance(20000);                                   // 23:59:50 - still the 14th
  assert.equal(await scan('AAAA1111'), 'checkout');
  assert.equal(sub.sessionsUsed, 1);
  assert.equal(sub.lastDeductedDayKey, '2026-10-14');
  advance(20000);                                   // 00:00:10 Manila, 15 Oct
  assert.equal(await scan('AAAA1111'), 'checkin');
  assert.equal(sub.sessionsUsed, 2);
  assert.equal(sub.lastDeductedDayKey, '2026-10-15');
  assert.deepEqual(attendance.map((a) => a.dayKey), ['2026-10-14', '2026-10-15']);
});

test('Manila midnight: a session left open overnight is retired (not invented), and the new day is charged once', async () => {
  const { sub } = addMember('Maria Santos', 'AAAA1111');
  at('2026-10-14T15:59:30Z');
  assert.equal(await scan('AAAA1111'), 'checkin');  // never taps out
  advance(70000);                                   // 00:00:40 Manila, 15 Oct
  assert.equal(await scan('AAAA1111'), 'checkin');  // new day's first Time-In, not a Time-Out
  assert.equal(attendance[0].missedCheckOut, true);
  assert.equal(attendance[0].checkOut, undefined, 'no time-out timestamp is invented');
  assert.equal(attendance[1].dayKey, '2026-10-15');
  assert.equal(sub.sessionsUsed, 2);
  advance(6000); await scan('AAAA1111'); advance(6000); await scan('AAAA1111');
  assert.equal(sub.sessionsUsed, 2, 'later sessions on the 15th do not charge again');
});

test('an unexpected database failure during deduction: the tap still succeeds, nothing is claimed, the next session retries', async () => {
  const { sub } = addMember('Maria Santos', 'AAAA1111');
  const real = Subscription.findOneAndUpdate;
  Subscription.findOneAndUpdate = async () => { throw new Error('simulated db failure'); };
  let first;
  try { first = await scan('AAAA1111'); } finally { Subscription.findOneAndUpdate = real; }
  assert.equal(first, 'checkin');
  assert.equal(attendance.length, 1, 'attendance saved');
  assert.equal(sub.sessionsUsed, 0, 'no deduction claimed');
  assert.equal(sub.lastDeductedDayKey, undefined);
  advance(6000); assert.equal(await scan('AAAA1111'), 'checkout');
  advance(6000); assert.equal(await scan('AAAA1111'), 'checkin');   // second session: retry succeeds
  assert.equal(sub.sessionsUsed, 1);
  advance(6000); await scan('AAAA1111'); advance(6000); await scan('AAAA1111');
  assert.equal(sub.sessionsUsed, 1, 'and never again that day');
});

test('Day Pass plan: tap works, no deduction, no marker', async () => {
  const { sub } = addMember('Day Dan', 'AAAA1111', { planId: { durationValue: 1, durationUnit: 'day' } });
  assert.equal(await scan('AAAA1111'), 'checkin');
  assert.equal(sub.sessionsUsed, 0);
  assert.equal(sub.lastDeductedDayKey, undefined);
});
