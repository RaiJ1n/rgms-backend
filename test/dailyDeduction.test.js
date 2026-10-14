// test/dailyDeduction.test.js - once-per-Manila-day session deduction
// (Subscription.lastDeductedDayKey). UNIT tests: the real subscriptionService
// and memberAttendanceService run over the in-memory model store. They prove
// the application logic and the shape of the conditional update, NOT real
// MongoDB behaviour - see test/dailyDeduction.mongo.test.js for that.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const { install, dup, nid, same } = require('./helpers/fakeStore');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');

const attendance = []; const subs = [];
install(Attendance, attendance, {}, (d, s) => {
  if (d.openSession === true && s.some((x) => x.openSession === true && same(x.userId, d.userId))) throw dup();
  if (typeof d.requestId === 'string' && s.some((x) => x.requestId === d.requestId)) throw dup();
});
install(Subscription, subs);

const subscriptionService = require('../services/subscriptionService');
const memberAttendance = require('../services/memberAttendanceService');
const { formatLocalDateLabel } = require('../utils/localDate');

const MEMBERSHIP = { durationValue: 1, durationUnit: 'month' };
const DAYPASS = { durationValue: 1, durationUnit: 'day' };
const TODAY = () => formatLocalDateLabel(new Date());
let n = 0;
function member(subOverrides) {
  const user = { _id: nid(), fullname: `M${++n}` };
  const sub = subOverrides === null ? null : Object.assign({ _id: nid(), userId: user._id, planId: MEMBERSHIP, endDate: new Date(Date.now() + 864e5 * 30), sessionsUsed: 0 }, subOverrides);
  if (sub) subs.push(sub);
  return { user, sub };
}
const reqId = () => `req-${++n}-abcdefgh`;
const checkInOut = async (user) => { // one full session
  const r = await memberAttendance.checkIn({ user, now: new Date() });
  await memberAttendance.checkOut({ user, now: new Date() });
  return r;
};

test('legacy subscription (no marker): first check-in deducts once and writes the marker', async () => {
  const { user, sub } = member();
  assert.equal('lastDeductedDayKey' in sub, false);
  const r = await memberAttendance.checkIn({ user, now: new Date() });
  assert.equal(r.deducted, true);
  assert.equal(sub.sessionsUsed, 1);
  assert.equal(sub.lastDeductedDayKey, TODAY());
});

test('several sessions on the same day deduct only once', async () => {
  const { user, sub } = member();
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push((await checkInOut(user)).deducted);
  assert.deepEqual(results, [true, false, false, false]);
  assert.equal(sub.sessionsUsed, 1);
  assert.equal(attendance.filter((a) => same(a.userId, user._id)).length, 4);
});

test('replayed request id returns the original result and does not deduct again', async () => {
  const { user, sub } = member();
  const id = reqId();
  const a = await memberAttendance.checkIn({ user, now: new Date(), requestId: id });
  await memberAttendance.checkOut({ user, now: new Date() });
  const b = await memberAttendance.checkIn({ user, now: new Date(), requestId: id });
  assert.equal(a.deducted, true);
  assert.equal(b.replayed, true);
  assert.equal(b.deducted, false);
  assert.equal(sub.sessionsUsed, 1);
});

test('concurrent first-of-day deduction attempts charge exactly once', async () => {
  const { user, sub } = member();
  const out = await Promise.all(Array.from({ length: 8 }, () => subscriptionService.recordAttendanceSession(user._id, { dayKey: '2026-10-14' })));
  assert.equal(out.filter((r) => r.deducted).length, 1);
  assert.equal(out.filter((r) => r.reason === 'already_deducted').length, 7);
  assert.equal(sub.sessionsUsed, 1);
  assert.equal(sub.lastDeductedDayKey, '2026-10-14');
});

test('a new Manila day deducts again; midnight boundary uses Manila time, not UTC', async () => {
  const { user, sub } = member();
  assert.equal((await subscriptionService.recordAttendanceSession(user._id, { dayKey: '2026-10-14' })).deducted, true);
  assert.equal((await subscriptionService.recordAttendanceSession(user._id, { dayKey: '2026-10-14' })).deducted, false);
  assert.equal((await subscriptionService.recordAttendanceSession(user._id, { dayKey: '2026-10-15' })).deducted, true);
  assert.equal(sub.sessionsUsed, 2);
  // 23:59:59.999 Manila vs 00:00:00 Manila next day (UTC+8)
  assert.equal(formatLocalDateLabel(new Date('2026-10-14T15:59:59.999Z')), '2026-10-14');
  assert.equal(formatLocalDateLabel(new Date('2026-10-14T16:00:00.000Z')), '2026-10-15');
  assert.equal(formatLocalDateLabel(new Date('2026-10-14T00:30:00.000Z')), '2026-10-14'); // 08:30 Manila, still the 14th
});

test('a FAILED deduction leaves no marker; the next check-in that day retries it once', async () => {
  const { user, sub } = member();
  const real = Subscription.findOneAndUpdate;
  Subscription.findOneAndUpdate = async () => { throw new Error('simulated db failure'); };
  let first;
  try { first = await checkInOut(user); } finally { Subscription.findOneAndUpdate = real; }
  assert.equal(first.deducted, false, 'must not claim a deduction that did not happen');
  assert.match(first.warning, /could not be updated/);
  assert.equal(attendance.some((a) => same(a.userId, user._id)), true, 'attendance row is still saved');
  assert.equal(sub.sessionsUsed, 0);
  assert.equal(sub.lastDeductedDayKey, undefined);

  const second = await checkInOut(user); // sessionsToday = 2
  assert.equal(second.deducted, true, 'retry succeeds even though it is not the first session');
  assert.equal(sub.sessionsUsed, 1);
  const third = await checkInOut(user);
  assert.equal(third.deducted, false);
  assert.equal(sub.sessionsUsed, 1);
});

test('database error while looking up the subscription is surfaced as a warning, not a deduction', async () => {
  const { user } = member();
  const real = Subscription.findOne;
  Subscription.findOne = () => { throw new Error('simulated lookup failure'); };
  let r;
  try { r = await memberAttendance.checkIn({ user, now: new Date() }); } finally { Subscription.findOne = real; }
  assert.equal(r.deducted, false);
  assert.ok(r.warning);
});

test('Day Pass plans are never deducted and get no marker', async () => {
  const { user, sub } = member({ planId: DAYPASS });
  const r = await memberAttendance.checkIn({ user, now: new Date() });
  assert.equal(r.deducted, false);
  assert.equal(sub.sessionsUsed, 0);
  assert.equal(sub.lastDeductedDayKey, undefined);
});

test('no subscription: attendance still recorded, nothing thrown', async () => {
  const { user } = member(null);
  const r = await memberAttendance.checkIn({ user, now: new Date() });
  assert.equal(r.deducted, false);
  assert.equal(r.warning, undefined);
});

test('deploy-day guard: a legacy subscription already charged today by the old code is not charged twice', async () => {
  const { user, sub } = member({ sessionsUsed: 3 }); // old code charged earlier today; marker never written
  await Attendance.create({ userId: user._id, subjectType: 'member', attendanceType: 'MEMBER', dayKey: TODAY(), checkIn: new Date(), checkOut: new Date() });
  const r = await memberAttendance.checkIn({ user, now: new Date() }); // 2nd session today
  assert.equal(r.deducted, false);
  assert.equal(sub.sessionsUsed, 3);
  assert.equal((await subscriptionService.recordAttendanceSession(user._id, { dayKey: '2099-01-01' })).deducted, true, 'next day charges normally');
  assert.equal(sub.sessionsUsed, 4);
});

test('legacy subscription never charged (sessionsUsed 0) still gets its missed deduction on a later session', async () => {
  const { user, sub } = member({ sessionsUsed: 0 });
  await Attendance.create({ userId: user._id, subjectType: 'member', attendanceType: 'MEMBER', dayKey: TODAY(), checkIn: new Date(), checkOut: new Date() });
  const r = await memberAttendance.checkIn({ user, now: new Date() });
  assert.equal(r.deducted, true);
  assert.equal(sub.sessionsUsed, 1);
});

test('historical balances are never decremented, reset or rewritten by a skipped deduction', async () => {
  const { user, sub } = member({ sessionsUsed: 7, lastDeductedDayKey: '2026-10-14' });
  const r = await subscriptionService.recordAttendanceSession(user._id, { dayKey: '2026-10-14' });
  assert.equal(r.reason, 'already_deducted');
  assert.equal(sub.sessionsUsed, 7);
  assert.equal(sub.lastDeductedDayKey, '2026-10-14');
});
