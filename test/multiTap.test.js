// test/multiTap.test.js - run with:  npm test
//
// Four consecutive intentional RFID taps (IN, OUT, IN, OUT) vs. repeated reader
// signals from ONE physical tap. These tests use REAL (short) time, not a
// faked clock: the debounce window is set to 60 ms and taps are spaced just
// beyond it, so they prove that a tap never has to wait out a long cooldown.
//
// Like the other suites this runs the real service/controller code over an
// in-memory model store; it proves application logic, not MongoDB behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.RFID_DEBOUNCE_MS = '60';
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
const emitted = [];
socketUtil.emitToAdmins = (ev, payload) => { emitted.push([ev, payload]); };
socketUtil.emitToUser = () => {};
const deductions = [];
require('../services/subscriptionService').recordAttendanceSession = async (id) => { deductions.push(String(id)); };

const attendanceService = require('../services/attendanceService');
const rfidController = require('../controllers/rfidController');
const scanDedup = require('../services/scanDedup');
const scanConfig = require('../utils/scanConfig');
const { TapDebouncer } = require('../utils/tapDebouncer');

// ------------------------------------------------------------------ helpers
const UID = 'AAAA1111';
const SPARE = 'CCCC3333';
const day = 24 * 3600 * 1000;
const WINDOW = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A deliberate second tap: the reader has been quiet for just over the window.
const liftAndRetap = () => sleep(WINDOW + 25);
let M;
const mine = () => attendance.filter((a) => same(a.userId, M._id));
const open = () => mine().filter((a) => !a.checkOut);
const closed = () => mine().filter((a) => a.checkOut);

function addMember(name, cardUid) {
  const u = { _id: nid(), fullname: name, email: `${name.toLowerCase().replace(/\s/g, '')}@x.test`, role: 'user', isActive: true };
  users.push(u);
  subs.push({ _id: nid(), userId: u._id, status: 'active', endDate: new Date(Date.now() + 30 * day) });
  if (cardUid) cards.push({ _id: nid(), cardId: cardUid, cardType: 'MEMBER', active: true, userId: u, createdAt: new Date() });
  return u;
}
const httpRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
// Calls the real POST /rfid/scan handler.
async function postScan(body, headers = {}) {
  const r = httpRes();
  await rfidController.scanCard(
    { body, headers, ip: '127.0.0.1' },
    r,
    (e) => { throw e; },
  );
  return r;
}
// What the real reader/bridge does for a physical tap that is still on the reader.
const holdFor = async (uid, signals, everyMs) => {
  const outcomes = [];
  for (let i = 0; i < signals; i += 1) {
    outcomes.push(await attendanceService.processScan(uid).then((r) => r.action, (e) => e.errorType));
    if (i < signals - 1) await sleep(everyMs);
  }
  return outcomes;
};

test.beforeEach(() => {
  [cards, attendance, users, subs, deductions, emitted].forEach((a) => { a.length = 0; });
  scanDedup._reset();
  process.env.RFID_DEBOUNCE_MS = String(WINDOW);
  M = addMember('Maria Santos', UID);
});

// --------------------------------------------------- the headline scenario
test('config: debounce window is configurable and defaults to a short sliding window (not a long cooldown)', () => {
  assert.equal(scanConfig.debounceMs, WINDOW);
  delete process.env.RFID_DEBOUNCE_MS;
  assert.equal(scanConfig.debounceMs, 1500);
  assert.ok(scanConfig.debounceMs < 10000, 'far below the old 10 s cooldown');
  process.env.RFID_DEBOUNCE_MS = 'garbage';
  assert.equal(scanConfig.debounceMs, 1500, 'invalid value falls back to the default');
  process.env.RFID_DEBOUNCE_MS = String(WINDOW);
});

test('four consecutive intentional taps: IN, OUT, IN, OUT = exactly two completed sessions', async () => {
  const actions = [];
  for (let i = 0; i < 4; i += 1) {
    if (i) await liftAndRetap();
    const r = await attendanceService.processScan(UID);
    actions.push(r.action);
  }
  assert.deepEqual(actions, ['checkin', 'checkout', 'checkin', 'checkout']);
  assert.equal(mine().length, 2, 'two session rows');
  assert.equal(closed().length, 2, 'both completed');
  assert.equal(open().length, 0, 'nothing left open');
  assert.equal(deductions.length, 1, 'one gym day = one subscription session');

  // every action saved with its own timestamp, in order, never overwritten
  const [s1, s2] = mine();
  assert.ok(s1.checkIn && s1.checkOut && s2.checkIn && s2.checkOut);
  assert.ok(s1.checkIn <= s1.checkOut && s1.checkOut <= s2.checkIn && s2.checkIn <= s2.checkOut);
  assert.equal(s1.dayKey, s2.dayKey, 'same day, two sessions');
});

test('tap 2 is NOT delayed by a leftover cooldown: it is accepted as soon as the reader has been quiet', async () => {
  const first = await attendanceService.processScan(UID);
  assert.equal(first.action, 'checkin');
  const started = Date.now();
  await liftAndRetap();
  const second = await attendanceService.processScan(UID);
  assert.equal(second.action, 'checkout');
  assert.ok(Date.now() - started < 1000, 'well under the old 10-second wait');
});

test('a fifth and sixth tap keep alternating (the 4-tap example is not a cap)', async () => {
  const actions = [];
  for (let i = 0; i < 6; i += 1) {
    if (i) await liftAndRetap();
    actions.push((await attendanceService.processScan(UID)).action);
  }
  assert.deepEqual(actions, ['checkin', 'checkout', 'checkin', 'checkout', 'checkin', 'checkout']);
  assert.equal(closed().length, 3);
});

// -------------------------------------------- one physical tap, many signals
test('one physical tap that the reader repeats 6 times creates ONE action', async () => {
  const out = await holdFor(UID, 6, 8); // all inside the window
  assert.equal(out[0], 'checkin');
  assert.deepEqual(out.slice(1), Array(5).fill('duplicate_signal'));
  assert.equal(mine().length, 1);
  assert.equal(open().length, 1, 'still checked in - repeats did not check out');
});

test('SLIDING window: a card resting on the reader for far longer than the window is still ONE tap', async () => {
  // 12 signals 20 ms apart = 240 ms held, 4x the 60 ms window. A fixed cooldown
  // would have let a repeat through after 60 ms and turned the hold into IN+OUT.
  const out = await holdFor(UID, 12, 20);
  assert.equal(out.filter((x) => x === 'checkin').length, 1);
  assert.equal(out.filter((x) => x === 'checkout').length, 0, 'a long hold never becomes a check-out');
  assert.equal(mine().length, 1);
  assert.equal(open().length, 1);
});

test('hold, lift, tap again: the next tap after the hold is the check-out', async () => {
  await holdFor(UID, 5, 15);
  await liftAndRetap();
  const out = await holdFor(UID, 5, 15);
  assert.equal(out[0], 'checkout');
  assert.ok(out.slice(1).every((x) => x === 'duplicate_signal'));
  assert.equal(mine().length, 1);
  assert.equal(closed().length, 1);
});

test('four intentional taps, each one held and repeated by the reader: still exactly IN, OUT, IN, OUT', async () => {
  const actions = [];
  for (let tapNo = 0; tapNo < 4; tapNo += 1) {
    if (tapNo) await liftAndRetap();
    const out = await holdFor(UID, 4, 12);
    actions.push(out[0]);
    assert.ok(out.slice(1).every((x) => x === 'duplicate_signal'), `tap ${tapNo + 1}: repeats ignored`);
  }
  assert.deepEqual(actions, ['checkin', 'checkout', 'checkin', 'checkout']);
  assert.equal(mine().length, 2);
  assert.equal(closed().length, 2);
});

test('rapid intentional taps just past the window are never blocked by the debounce', async () => {
  // spacing = window + 5 ms: the tightest legal rhythm
  const actions = [];
  for (let i = 0; i < 4; i += 1) {
    if (i) await sleep(WINDOW + 5);
    actions.push((await attendanceService.processScan(UID)).action);
  }
  assert.deepEqual(actions, ['checkin', 'checkout', 'checkin', 'checkout']);
});

test('the debounce is per card: two members tapping at the same moment do not affect each other', async () => {
  const M2 = addMember('Juan Dela Cruz', 'BBBB2222');
  const [a, b] = await Promise.all([attendanceService.processScan(UID), attendanceService.processScan('BBBB2222')]);
  assert.equal(a.action, 'checkin');
  assert.equal(b.action, 'checkin');
  assert.equal(attendance.filter((x) => same(x.userId, M2._id)).length, 1);
});

// -------------------------------------------------------------- concurrency
test('simultaneous identical signals (same instant) create exactly one action', async () => {
  const r = await Promise.allSettled(Array.from({ length: 8 }, () => attendanceService.processScan(UID)));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.errorType === 'duplicate_signal'));
  assert.equal(mine().length, 1);
  assert.equal(open().length, 1);
});

test('simultaneous scans can never create two open sessions (original card + spare card, same member)', async () => {
  cards.push({ _id: nid(), cardId: SPARE, cardType: 'TEMPORARY', active: true, memberAssignmentId: 'asg1', createdAt: new Date() });
  const TempCardAssignment = require('../models/TempCardAssignment');
  const assignments = [{ _id: 'asg1', memberId: M._id, status: 'ACTIVE', expiresAt: new Date(Date.now() + day) }];
  install(TempCardAssignment, assignments);
  const r = await Promise.allSettled([
    attendanceService.processScan(UID), attendanceService.processScan(SPARE),
    attendanceService.processScan(UID), attendanceService.processScan(SPARE),
  ]);
  assert.ok(open().length <= 1, 'never more than one open session');
  assert.ok(mine().length <= 2);
  const ok = r.filter((x) => x.status === 'fulfilled').map((x) => x.value.action);
  // whatever got through alternated strictly, starting with check-in
  ok.forEach((a, i) => assert.equal(a, i % 2 === 0 ? 'checkin' : 'checkout'));
  for (const x of r.filter((y) => y.status === 'rejected')) assert.ok(['duplicate_signal', 'duplicate_scan'].includes(x.reason.errorType));
});

// --------------------------------------------------- duplicate API requests
test('POST /rfid/scan: a retried request with the same scanId returns the original result and creates nothing new', async () => {
  const first = await postScan({ cardId: UID, scanId: 'bridge1-tap-0001' });
  assert.equal(first.code, 200);
  assert.equal(first.body.action, 'checkin');
  const retry = await postScan({ cardId: UID, scanId: 'bridge1-tap-0001' }); // lost response -> bridge retries
  assert.equal(retry.code, 200);
  assert.equal(retry.body.action, 'checkin', 'same answer, not "duplicate" and not a check-out');
  assert.equal(retry.body.replayed, true);
  assert.equal(String(retry.body.data._id), String(first.body.data._id));
  assert.equal(mine().length, 1);
  assert.equal(emitted.filter(([e]) => e === 'attendance').length, 1, 'announced to the front desk once');
});

test('POST /rfid/scan: the same scanId arriving twice at once is executed once', async () => {
  const [a, b, c] = await Promise.all([
    postScan({ cardId: UID, scanId: 'bridge1-tap-0002' }),
    postScan({ cardId: UID, scanId: 'bridge1-tap-0002' }),
    postScan({ cardId: UID, scanId: 'bridge1-tap-0002' }),
  ]);
  assert.deepEqual([a.code, b.code, c.code], [200, 200, 200]);
  assert.equal(mine().length, 1);
  assert.equal(deductions.length, 1);
  assert.equal(new Set([a, b, c].map((x) => String(x.body.data._id))).size, 1);
});

test('replay survives a server restart: the database idempotency key answers when the in-memory cache is gone', async () => {
  await postScan({ cardId: UID, scanId: 'bridge1-tap-0003' });
  scanDedup._reset(); // restart / other process
  const retry = await postScan({ cardId: UID, scanId: 'bridge1-tap-0003' });
  assert.equal(retry.code, 200);
  assert.equal(retry.body.action, 'checkin');
  assert.equal(mine().length, 1);
  // ...and also after the debounce window, when the retry reaches the toggle itself:
  await liftAndRetap();
  scanDedup._reset();
  const late = await postScan({ cardId: UID, scanId: 'bridge1-tap-0003' });
  assert.equal(late.body.action, 'checkin', 'still the ORIGINAL action, not a check-out');
  assert.equal(mine().length, 1);
  assert.equal(open().length, 1);
});

test('a check-out retry is replayed as a check-out (no second close, no new session)', async () => {
  await postScan({ cardId: UID, scanId: 'bridge1-in-0001' });
  await liftAndRetap();
  const out = await postScan({ cardId: UID, scanId: 'bridge1-out-0001' });
  assert.equal(out.body.action, 'checkout');
  const closedAt = mine()[0].checkOut;
  scanDedup._reset();
  const retry = await postScan({ cardId: UID, scanId: 'bridge1-out-0001' });
  assert.equal(retry.body.action, 'checkout');
  assert.equal(retry.body.replayed, true);
  assert.equal(+mine()[0].checkOut, +closedAt, 'close timestamp untouched');
  assert.equal(mine().length, 1);
});

test('distinct scanIds are distinct taps; a malformed scanId is ignored, never a failure', async () => {
  const a = await postScan({ cardId: UID, scanId: 'bridge1-tap-0010' });
  await liftAndRetap();
  const b = await postScan({ cardId: UID, scanId: 'bridge1-tap-0011' });
  assert.deepEqual([a.body.action, b.body.action], ['checkin', 'checkout']);
  await liftAndRetap();
  const c = await postScan({ cardId: UID, scanId: 'x y!' }); // invalid -> treated as no id
  assert.equal(c.code, 200);
  assert.equal(c.body.action, 'checkin');
});

// --------------------------------------------------------- feedback / errors
test('REST feedback: success says which action; a repeated signal is a silent 429; denial keeps its own message', async () => {
  const ok = await postScan({ cardId: UID });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.action, 'checkin');
  assert.equal(ok.body.lcd.line1, 'WELCOME');

  const repeat = await postScan({ cardId: UID });
  assert.equal(repeat.code, 429);
  assert.equal(repeat.body.errorType, 'duplicate_signal');
  assert.equal(repeat.body.duplicate, true);
  assert.equal(repeat.body.silent, true, 'tells the bridge to leave the LCD alone');

  const unknown = await postScan({ cardId: 'FFFF9999' });
  assert.equal(unknown.code, 404);
  assert.equal(unknown.body.silent, undefined, 'a real failure is NOT silent');
  assert.equal(unknown.body.lcd.line1, 'RFID NOT');
});

test('a repeated signal produces no admin popup and no second attendance event', async () => {
  await attendanceService.processScan(UID);
  const before = emitted.length;
  await attendanceService.processScan(UID).catch(() => {});
  await attendanceService.processScan(UID).catch(() => {});
  assert.equal(emitted.length, before);
});

// -------------------------------------------- membership rules still apply
test('membership validation is not bypassed: the 3rd tap is refused if the plan expired after the 2nd', async () => {
  await attendanceService.processScan(UID);
  await liftAndRetap();
  await attendanceService.processScan(UID);
  subs.find((s) => same(s.userId, M._id)).endDate = new Date(Date.now() - 1000);
  await liftAndRetap();
  await assert.rejects(() => attendanceService.processScan(UID), (e) => e.errorType === 'subscription_expired');
  assert.equal(mine().length, 1);
  assert.equal(closed().length, 1);
});

test('a denied card held on the reader raises ONE denial, not one per repeated signal', async () => {
  subs.find((s) => same(s.userId, M._id)).endDate = new Date(Date.now() - 1000);
  const out = await holdFor(UID, 5, 10);
  assert.equal(out[0], 'subscription_expired');
  assert.ok(out.slice(1).every((x) => x === 'duplicate_signal'));
  assert.equal(emitted.filter(([e]) => e === 'rfid:error').length, 1);
});

test('a deactivated card and an unregistered card are still refused with their own errors', async () => {
  cards.find((c) => c.cardId === UID).active = false;
  await assert.rejects(() => attendanceService.processScan(UID), (e) => e.errorType === 'card_deactivated');
  await assert.rejects(() => attendanceService.processScan('FFFF9999'), (e) => e.errorType === 'card_unregistered');
  assert.equal(attendance.length, 0);
});

// ------------------------------------------------- failure handling
test('an unexpected failure releases the claim: the member can retry immediately, not after the window', async () => {
  const realCreate = Attendance.create;
  Attendance.create = async () => { throw new Error('database timed out'); };
  await assert.rejects(() => attendanceService.processScan(UID), (e) => !e.statusCode);
  Attendance.create = realCreate;
  assert.equal(attendance.length, 0, 'nothing half-saved');
  const retry = await attendanceService.processScan(UID); // NO wait
  assert.equal(retry.action, 'checkin');
  assert.equal(mine().length, 1);
});

test('RFID_DEBOUNCE_MS=0 disables the filter (atomic open-session guard still prevents duplicates)', async () => {
  process.env.RFID_DEBOUNCE_MS = '0';
  const actions = [];
  for (let i = 0; i < 4; i += 1) actions.push((await attendanceService.processScan(UID)).action);
  assert.deepEqual(actions, ['checkin', 'checkout', 'checkin', 'checkout']);
  const burst = await Promise.allSettled(Array.from({ length: 6 }, () => attendanceService.processScan(UID)));
  assert.ok(open().length <= 1);
  assert.ok(burst.length === 6);
});

// ---------------------------- existing data keeps working / multi-session UI
test('existing cards and history are untouched: a card with no lastSignalAt (every pre-existing card) just works', async () => {
  const card = cards.find((c) => c.cardId === UID);
  assert.equal(card.lastSignalAt, undefined);
  assert.equal((await attendanceService.processScan(UID)).action, 'checkin');
  assert.ok(card.lastSignalAt instanceof Date);
});

test('a legacy open row from before this change (no openSession flag) is closed by the next tap', async () => {
  attendance.push({ _id: nid(), userId: M._id, subjectType: 'member', checkIn: new Date(), createdAt: new Date() });
  const r = await attendanceService.processScan(UID);
  assert.equal(r.action, 'checkout');
  assert.equal(attendance.length, 1);
});

test('today\'s admin feed lists BOTH sessions of the day as separate rows', async () => {
  await attendanceService.processScan(UID); await liftAndRetap();
  await attendanceService.processScan(UID); await liftAndRetap();
  await attendanceService.processScan(UID); await liftAndRetap();
  await attendanceService.processScan(UID);
  Attendance.find = () => ({
    populate() { return this; }, sort() { return this; }, select() { return this; }, lean() { return this; },
    then(res, rej) { return Promise.resolve(attendance.slice()).then(res, rej); },
  });
  const r = httpRes();
  await rfidController.todayAttendance({}, r, (e) => { throw e; });
  assert.equal(r.body.count, 2);
  // Each row is labelled with its own session number for the admin table.
  assert.deepEqual(r.body.data.map((x) => x.sessionNo).sort(), [1, 2]);
  assert.ok(r.body.data.every((x) => x.sessionsThatDay === 2));
  assert.equal(new Set(r.body.data.map((x) => String(x._id))).size, 2, 'distinct rows');
  assert.ok(r.body.data.every((x) => x.checkIn && x.checkOut));
});

// ------------------------------------------- bridge debounce (pure, exact clock)
test('TapDebouncer: reader patterns with exact timestamps', () => {
  const d = new TapDebouncer(300);
  // held card re-sending every 100 ms for 1.2 s = one tap
  const held = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200].map((t) => d.observe('A', t).isNewTap);
  assert.deepEqual(held, [true, ...Array(12).fill(false)]);
  // lifted for 350 ms, tapped again = new tap (and its own repeats are ignored)
  assert.equal(d.observe('A', 1550).isNewTap, true);
  assert.equal(d.observe('A', 1650).isNewTap, false);
  // quick but deliberate: exactly at the window edge counts as new
  assert.equal(d.observe('A', 1950).isNewTap, true);
  // another card at the same moment is independent
  assert.equal(d.observe('B', 1960).isNewTap, true);
  // window 0 disables
  const off = new TapDebouncer(0);
  assert.deepEqual([off.observe('A', 0), off.observe('A', 1)].map((x) => x.isNewTap), [true, true]);
});
