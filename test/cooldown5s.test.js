// test/cooldown5s.test.js - the 5-second per-card duplicate-tap rule, with a
// MOCKED clock (no waiting). Runs the real service/controller code over the
// in-memory model store used by the other suites: it proves application logic,
// not MongoDB behaviour (the atomic claim is one conditional update on the card
// document; see services/attendanceService.js claimSignal).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
delete process.env.RFID_DEBOUNCE_MS;       // use the real defaults
delete process.env.RFID_DEBOUNCE_SKEW_MS;
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
const emitted = [];
socketUtil.emitToAdmins = (ev, payload) => { emitted.push([ev, payload]); };
socketUtil.emitToUser = () => {};
const deductions = [];
require('../services/subscriptionService').recordAttendanceSession = async (id, o = {}) => { if (o.firstOfDay === false) return { deducted: false }; deductions.push(String(id)); return { deducted: true }; }; // mimics the real service for a repeat session

const attendanceService = require('../services/attendanceService');
const rfidController = require('../controllers/rfidController');
const scanDedup = require('../services/scanDedup');
const scanConfig = require('../utils/scanConfig');

const day = 24 * 3600 * 1000;
const START = Date.parse('2026-10-14T03:00:00Z'); // 11:00 in Manila
let clock; // mocked Date
const at = (ms) => { clock.setTime(START + ms); };   // jump to START + ms
const scan = (uid, opts) => attendanceService.processScan(uid, opts).then((r) => r.action, (e) => e.errorType);
const httpRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
async function postScan(body) {
  const r = httpRes();
  await rfidController.scanCard({ body, headers: {}, ip: '127.0.0.1' }, r, (e) => { throw e; });
  return r;
}

function addMember(name, uid) {
  const u = { _id: nid(), fullname: name, email: `${name.toLowerCase().replace(/\s/g, '')}@x.test`, role: 'user', isActive: true };
  users.push(u);
  subs.push({ _id: nid(), userId: u._id, status: 'active', endDate: new Date(START + 30 * day) });
  cards.push({ _id: nid(), cardId: uid, cardType: 'MEMBER', active: true, userId: u, createdAt: new Date() });
  return u;
}
const rowsOf = (u) => attendance.filter((a) => same(a.userId, u._id));

let M;
test.beforeEach((t) => {
  [cards, attendance, users, subs, deductions, emitted].forEach((a) => { a.length = 0; });
  scanDedup._reset();
  delete process.env.RFID_DEBOUNCE_MS;
  delete process.env.RFID_DEBOUNCE_SKEW_MS;
  t.mock.timers.enable({ apis: ['Date'], now: START });
  clock = t.mock.timers;
  clock.setTime = (ms) => { clock.tick(ms - Date.now()); };
  M = addMember('Maria Santos', 'AAAA1111');
});

test('defaults: 5 s window, 300 ms timing allowance -> the server compares against 4.7 s', () => {
  assert.equal(scanConfig.debounceMs, 5000);
  assert.equal(scanConfig.debounceSkewMs, 300);
  assert.equal(scanConfig.effectiveDebounceMs, 4700);
  process.env.RFID_DEBOUNCE_SKEW_MS = '0';
  assert.equal(scanConfig.effectiveDebounceMs, 5000, 'allowance can be switched off for an exact 5 s');
  process.env.RFID_DEBOUNCE_MS = '60';
  assert.equal(scanConfig.effectiveDebounceMs, 60, 'allowance 0 -> exact');
  delete process.env.RFID_DEBOUNCE_SKEW_MS;
  assert.equal(scanConfig.effectiveDebounceMs, 54, 'a short window only gives up 10%');
  process.env.RFID_DEBOUNCE_MS = '0';
  assert.equal(scanConfig.effectiveDebounceMs, 0, 'disabled stays disabled');
});

test('first tap creates attendance; repeats inside the window create nothing and deduct nothing', async () => {
  at(0);
  assert.equal(await scan('AAAA1111'), 'checkin');
  for (const ms of [1, 500, 2000, 4000]) {
    at(ms);
    assert.equal(await scan('AAAA1111'), 'duplicate_signal', `repeat at +${ms} ms`);
  }
  assert.equal(rowsOf(M).length, 1, 'still ONE row');
  assert.equal(rowsOf(M).filter((a) => a.openSession).length, 1);
  assert.equal(deductions.length, 1, 'one deduction, not one per signal');
  assert.equal(emitted.filter(([ev]) => ev === 'attendance').length, 1, 'one attendance event, not one per signal');
});

test('a new intentional tap after the window works, again and again, the same day', async () => {
  const seq = [];
  for (let i = 0; i < 4; i += 1) { at(i * 5000); seq.push(await scan('AAAA1111')); } // exactly 5.000 s apart
  assert.deepEqual(seq, ['checkin', 'checkout', 'checkin', 'checkout']);
  const rows = rowsOf(M);
  assert.equal(rows.length, 2, 'two sessions on one day');
  assert.ok(rows.every((r) => r.checkIn && r.checkOut));
  assert.equal(rows[0].dayKey, rows[1].dayKey);
  assert.equal(deductions.length, 1, 'existing policy unchanged: one subscription session per gym day');
});

test('timing allowance: a tap that reaches the server at 4.8 s is a real tap, one at 4.6 s is a duplicate', async () => {
  at(0); assert.equal(await scan('AAAA1111'), 'checkin');
  at(4600); assert.equal(await scan('AAAA1111'), 'duplicate_signal');

  [attendance, deductions, emitted].forEach((a) => { a.length = 0; });
  cards.length = 0; users.length = 0; subs.length = 0; scanDedup._reset();
  M = addMember('Maria Santos', 'AAAA1111');
  at(100000);
  assert.equal(await scan('AAAA1111'), 'checkin');
  at(100000 + 4800);
  assert.equal(await scan('AAAA1111'), 'checkout', 'a 5.0 s tap that arrived 200 ms early is not lost');
});

test('the window is per card: one member never blocks another', async () => {
  const N = addMember('Noel Reyes', 'BBBB2222');
  at(0);
  const [a, b] = await Promise.all([scan('AAAA1111'), scan('BBBB2222')]);
  assert.deepEqual([a, b], ['checkin', 'checkin']);
  at(10);
  assert.equal(await scan('AAAA1111'), 'duplicate_signal', 'A repeated');
  assert.equal(await scan('BBBB2222'), 'duplicate_signal', 'B repeated');
  assert.equal(rowsOf(M).length, 1);
  assert.equal(rowsOf(N).length, 1);
  assert.equal(deductions.length, 2, 'one per member');
});

test('A, then B, then A again inside the window: the second A is still a duplicate', async () => {
  addMember('Noel Reyes', 'BBBB2222');
  at(0); assert.equal(await scan('AAAA1111'), 'checkin');
  at(300); assert.equal(await scan('BBBB2222'), 'checkin');
  at(1500); assert.equal(await scan('AAAA1111'), 'duplicate_signal');
});

test('simultaneous identical requests (same tap, different scanIds) create exactly one entry', async () => {
  at(0);
  const r = await Promise.all(Array.from({ length: 6 }, () => scan('AAAA1111')));
  assert.equal(r.filter((x) => x === 'checkin').length, 1);
  assert.ok(r.filter((x) => x !== 'checkin').every((x) => x === 'duplicate_signal' || x === 'duplicate_scan'));
  assert.equal(rowsOf(M).length, 1);
  assert.equal(deductions.length, 1);
});

test('retry of the SAME tap that arrives after the window (bridge timeout + retry) and after a server restart returns the original result', async () => {
  at(0);
  const first = await postScan({ cardId: 'AAAA1111', scanId: 'bridge-tap-0001' });
  assert.equal(first.body.action, 'checkin');
  at(8400);                 // bridge: 8 s timeout + 0.4 s pause, then it retries
  scanDedup._reset();       // ...and the server process has restarted meanwhile
  const retry = await postScan({ cardId: 'AAAA1111', scanId: 'bridge-tap-0001' });
  assert.equal(retry.code, 200);
  assert.equal(retry.body.action, 'checkin', 'the original result, not a toggle to check-out');
  assert.equal(retry.body.replayed, true);
  assert.equal(rowsOf(M).length, 1, 'no second row');
  assert.ok(rowsOf(M)[0].openSession, 'session is still open: nothing was closed by the retry');
  assert.equal(deductions.length, 1, 'no second deduction');
});

test('a rejected duplicate answers clearly and never looks like a success', async () => {
  at(0);
  await postScan({ cardId: 'AAAA1111', scanId: 'bridge-tap-0002' });
  at(2000);
  const r = await postScan({ cardId: 'AAAA1111', scanId: 'bridge-tap-0003' });
  assert.equal(r.code, 429);
  assert.equal(r.body.success, false);
  assert.equal(r.body.errorType, 'duplicate_signal');
  assert.deepEqual(r.body.lcd, { line1: 'DUPLICATE', line2: 'SCAN IGNORED' });
  assert.equal(r.body.action, undefined, 'no action is reported for a rejected tap');
});

test('inside the window an unknown card and a deactivated card still get their own errors', async () => {
  cards[0].active = false;
  at(0);
  assert.equal(await scan('AAAA1111'), 'card_deactivated');
  assert.equal(await scan('FFFF9999'), 'card_unregistered');
});

test('an expired subscription is still refused on a tap that is past the window', async () => {
  at(0); assert.equal(await scan('AAAA1111'), 'checkin');
  subs[0].endDate = new Date(START + 6000);
  at(10000);
  assert.equal(await scan('AAAA1111'), 'subscription_expired');
  assert.equal(rowsOf(M).filter((a) => a.openSession).length, 1, 'the open session was not touched');
});