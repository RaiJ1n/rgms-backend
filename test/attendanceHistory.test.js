// test/attendanceHistory.test.js - run with:  npm test
//
// Read-side labelling for the Member and Admin attendance tables: several
// sessions on one date stay separate rows, each gets its own session number,
// open sessions are "Inside" (Time-Out empty), and date filters are Manila-day
// inclusive. Uses the in-memory store (verifies logic, not real MongoDB).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { install, nid } = require('./helpers/fakeStore');
const Attendance = require('../models/Attendance');
const history = require('../services/attendanceHistoryService');

const rows = [];
install(Attendance, rows, {});

// Manila (UTC+8) wall-clock -> instant
const at = (day, hm) => new Date(`${day}T${hm}:00+08:00`);

test('three visits in one day stay three rows, numbered 1..3', async () => {
  rows.length = 0;
  const userId = nid();
  const day = '2026-10-10';
  const spans = [['07:00', '09:00'], ['12:00', '13:30'], ['17:00', '19:00']];
  for (const [i, o] of spans) {
    await Attendance.create({ userId, checkIn: at(day, i), checkOut: at(day, o), createdAt: at(day, i) });
  }
  const list = (await Attendance.find({ userId })).map((d) => d.toObject());
  const out = await history.decorate(list, at(day, '20:00'));

  assert.equal(out.length, 3);
  const byIn = [...out].sort((a, b) => a.checkIn - b.checkIn);
  assert.deepEqual(byIn.map((r) => r.sessionNo), [1, 2, 3]);
  assert.ok(byIn.every((r) => r.sessionsThatDay === 3));
  assert.ok(byIn.every((r) => r.status === 'Completed'));
  assert.ok(byIn.every((r) => r.dayKey === day));
});

test('open session today is Inside; open row from an earlier day is No time-out', async () => {
  rows.length = 0;
  const userId = nid();
  await Attendance.create({ userId, checkIn: at('2026-10-09', '18:00'), createdAt: at('2026-10-09', '18:00') });
  await Attendance.create({ userId, checkIn: at('2026-10-10', '08:00'), createdAt: at('2026-10-10', '08:00') });
  const list = (await Attendance.find({ userId })).map((d) => d.toObject());
  const out = await history.decorate(list, at('2026-10-10', '09:00'));
  const yesterday = out.find((r) => r.dayKey === '2026-10-09');
  const today = out.find((r) => r.dayKey === '2026-10-10');
  assert.equal(yesterday.status, 'No time-out');
  assert.equal(today.status, 'Inside');
  // numbering restarts each day
  assert.equal(yesterday.sessionNo, 1);
  assert.equal(today.sessionNo, 1);
});

test('numbering is per person: two members on the same day do not interfere', async () => {
  rows.length = 0;
  const a = nid(); const b = nid();
  const day = '2026-10-10';
  await Attendance.create({ userId: a, checkIn: at(day, '07:00'), checkOut: at(day, '08:00'), createdAt: at(day, '07:00') });
  await Attendance.create({ userId: b, checkIn: at(day, '07:30'), checkOut: at(day, '08:30'), createdAt: at(day, '07:30') });
  await Attendance.create({ userId: a, checkIn: at(day, '10:00'), checkOut: at(day, '11:00'), createdAt: at(day, '10:00') });
  const list = (await Attendance.find({})).map((d) => d.toObject());
  const out = await history.decorate(list, at(day, '12:00'));
  const forA = out.filter((r) => String(r.userId) === String(a)).sort((x, y) => x.checkIn - y.checkIn);
  const forB = out.filter((r) => String(r.userId) === String(b));
  assert.deepEqual(forA.map((r) => r.sessionNo), [1, 2]);
  assert.deepEqual(forB.map((r) => r.sessionNo), [1]);
  assert.equal(forB[0].sessionsThatDay, 1);
});

test('rows without an account (visitor / walk-in) are labelled but not numbered', async () => {
  rows.length = 0;
  await Attendance.create({ guestName: 'Visitor', checkIn: at('2026-10-10', '09:00'), createdAt: at('2026-10-10', '09:00') });
  const list = (await Attendance.find({})).map((d) => d.toObject());
  const out = await history.decorate(list, at('2026-10-10', '09:30'));
  assert.equal(out[0].sessionNo, null);
  assert.equal(out[0].status, 'Inside');
});

test('flagged missedCheckOut row is never shown as Inside', () => {
  const now = at('2026-10-10', '09:00');
  assert.equal(history.statusOf({ checkIn: at('2026-10-10', '08:00'), missedCheckOut: true }, now), 'No time-out');
});

test('dateFilter: Manila-day inclusive range, ISO instants still accepted, bad dates rejected', () => {
  const r = history.dateFilter('2026-10-10', '2026-10-10');
  assert.equal(r.ok, true);
  assert.equal(+r.range.$gte, +at('2026-10-10', '00:00'));
  assert.equal(+r.range.$lte, +at('2026-10-10', '23:59') + 59999); // 23:59:59.999
  assert.equal(history.dateFilter().range, null);

  const iso = history.dateFilter('2026-10-04T00:00:00.000Z', '2026-10-10T23:59:59.999Z');
  assert.equal(iso.ok, true);
  assert.equal(+iso.range.$gte, +new Date('2026-10-04T00:00:00.000Z'));

  assert.equal(history.dateFilter('2026-02-31', undefined).ok, false);
  assert.equal(history.dateFilter('2026-10-12', '2026-10-10').ok, false);
  assert.equal(history.dateFilter('nonsense', undefined).ok, false);
});

test('insideFilter targets open rows from today only', () => {
  const f = history.insideFilter(at('2026-10-10', '09:00'));
  assert.deepEqual(f.checkOut, { $exists: false });
  assert.equal(+f.createdAt.$gte, +at('2026-10-10', '00:00'));
});
