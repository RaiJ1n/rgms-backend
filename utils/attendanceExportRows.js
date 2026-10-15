// utils/attendanceExportRows.js
//
// Row shaping for the attendance Excel export. Pure (no DB). One row per
// attendance SESSION - never grouped by member. Only these columns are ever
// exported: no email, phone, card UID/hash, tokens or other account data.
const TZ = 'Asia/Manila';

const COLUMNS = [
  { header: 'Attendance ID', width: 26 },
  { header: 'Member ID', width: 26 },
  { header: 'Name', width: 26 },
  { header: 'Date (Asia/Manila)', width: 18 },
  { header: 'Time In', width: 11 },
  { header: 'Time Out', width: 11 },
  { header: 'Session', width: 11 },
  { header: 'Status', width: 14 },
  { header: 'Type', width: 14 },
  { header: 'Plan Type', width: 11 },
  { header: 'Method', width: 10 },
];

const TYPE_LABEL = { MEMBER: 'Member', VISITOR: 'Visitor Pass', EMPLOYEE: 'Employee', GUEST: 'Walk-in' };
const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : '');

function manilaDate(d) {
  if (!d) return '';
  return new Date(new Date(d).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function manilaTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
}

// Stops spreadsheet formula injection from names typed at the front desk.
function safeCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function toValues(row) {
  const name = row.userId?.fullname || row.coachId?.fullname || row.guestName || 'Unknown';
  const type = row.attendanceType || 'GUEST';
  const status = row.status === 'Completed' ? 'Checked Out' : row.status || '';
  const session = row.sessionNo ? (row.sessionsThatDay > 1 ? `#${row.sessionNo} of ${row.sessionsThatDay}` : '#1') : '';
  const manual = !row.rfidCardId || row.notes === 'Visitor pass (manually recorded by admin)';
  return [
    String(row._id),
    idOf(row.userId) || idOf(row.coachId),
    safeCell(name),
    manilaDate(row.checkIn || row.createdAt),
    manilaTime(row.checkIn),
    manilaTime(row.checkOut),
    session,
    status,
    TYPE_LABEL[type] || 'Walk-in',
    type === 'VISITOR' ? '' : row.memberType || 'Regular',
    manual ? 'Manual' : 'Card',
  ];
}

function fileName(startDate, endDate, today = manilaDate(new Date())) {
  const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (ok(startDate) && ok(endDate)) {
    return startDate === endDate ? `REMER_Attendance_${startDate}.xlsx` : `REMER_Attendance_${startDate}_to_${endDate}.xlsx`;
  }
  if (ok(startDate)) return `REMER_Attendance_from_${startDate}.xlsx`;
  if (ok(endDate)) return `REMER_Attendance_until_${endDate}.xlsx`;
  return `REMER_Attendance_all_${today}.xlsx`;
}

module.exports = { COLUMNS, toValues, fileName, manilaDate, manilaTime, safeCell };
