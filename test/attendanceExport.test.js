const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../utils/attendanceExportRows');

const base = { _id: 'att1', userId: { _id: 'mem1', fullname: 'Ana Reyes' }, attendanceType: 'MEMBER', memberType: 'Student', status: 'Completed', rfidCardId: { cardType: 'PERMANENT' },
  checkIn: new Date('2026-10-14T23:30:00+08:00'), checkOut: new Date('2026-10-15T01:05:00+08:00'), createdAt: new Date('2026-10-14T23:30:00+08:00'), sessionNo: 1, sessionsThatDay: 2 };

test('columns are the intended set and contain no sensitive fields', () => {
  const headers = X.COLUMNS.map((c) => c.header.toLowerCase()).join('|');
  for (const bad of ['email', 'phone', 'password', 'token', 'uid', 'hash']) assert.ok(!headers.includes(bad), bad);
  assert.equal(X.toValues(base).length, X.COLUMNS.length);
});

test('dates and times are Asia/Manila (23:30 Manila stays on the 14th; checkout is the 15th)', () => {
  const v = X.toValues(base);
  assert.equal(v[3], '2026-10-14');
  assert.equal(v[4], '11:30 PM');
  assert.equal(v[5], '1:05 AM');
});

test('multiple sessions by one member stay as separate rows with their own ids', () => {
  const a = X.toValues({ ...base, _id: 's1', sessionNo: 1 });
  const b = X.toValues({ ...base, _id: 's2', sessionNo: 2 });
  assert.notEqual(a[0], b[0]);
  assert.equal(a[1], b[1]);
  assert.equal(a[6], '#1 of 2');
  assert.equal(b[6], '#2 of 2');
});

test('visitor, walk-in, employee and still-inside rows', () => {
  const visitor = X.toValues({ _id: 'v', attendanceType: 'VISITOR', guestName: 'Pat', checkIn: base.checkIn, status: 'Present', notes: 'Visitor pass (manually recorded by admin)' });
  assert.equal(visitor[1], '');
  assert.equal(visitor[8], 'Visitor Pass');
  assert.equal(visitor[9], '');
  assert.equal(visitor[10], 'Manual');
  assert.equal(visitor[5], '');
  const emp = X.toValues({ _id: 'e', coachId: { _id: 'c1', fullname: 'Coach Mike' }, attendanceType: 'EMPLOYEE', checkIn: base.checkIn, rfidCardId: {} });
  assert.equal(emp[1], 'c1');
  assert.equal(emp[8], 'Employee');
  assert.equal(emp[10], 'Card');
});

test('spreadsheet formula injection in names is neutralised', () => {
  assert.equal(X.toValues({ ...base, userId: { _id: 'x', fullname: '=HYPERLINK("http://evil")' } })[2], `'=HYPERLINK("http://evil")`);
  assert.equal(X.safeCell('Normal Name'), 'Normal Name');
});

test('descriptive file names', () => {
  assert.equal(X.fileName('2026-10-14', '2026-10-14'), 'REMER_Attendance_2026-10-14.xlsx');
  assert.equal(X.fileName('2026-10-01', '2026-10-14'), 'REMER_Attendance_2026-10-01_to_2026-10-14.xlsx');
  assert.equal(X.fileName('', '', '2026-10-15'), 'REMER_Attendance_all_2026-10-15.xlsx');
  assert.equal(X.fileName('../../etc', '2026-10-14', '2026-10-15'), 'REMER_Attendance_until_2026-10-14.xlsx');
});
