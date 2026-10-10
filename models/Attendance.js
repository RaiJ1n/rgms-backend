const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  // Member attendance (unchanged) — userId set, coachId left empty.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  guestName: { type: String, trim: true },

  // Employee/coach attendance (new) — coachId set, userId left empty.
  // Kept as its own field rather than reusing userId against the Coach
  // collection, since userId's `ref: 'User'` would populate against the
  // wrong collection for an employee row.
  coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach' },

  // 'member' (default) or 'employee' — lets every existing member-only
  // query (dashboards, reports, RFID logs) keep working unchanged by
  // filtering on subjectType: 'member' where it matters, while still
  // keeping both kinds of attendance in one collection/one set of
  // aggregation pipelines rather than duplicating all of that logic
  // across two collections. See attendanceService.js's processScan for
  // where this gets set.
  subjectType: { type: String, enum: ['member', 'employee'], default: 'member' },

  // Reliable source of the record, set server-side on every create:
  //   MEMBER   - a member account (userId set)
  //   VISITOR  - a visitor pass (rfidCardId points at a TEMPORARY card)
  //   EMPLOYEE - a coach/employee (coachId set)
  //   GUEST    - manually-entered walk-in with no account and no pass
  // subjectType is intentionally left as-is (visitors/guests stay 'member')
  // because the analytics "Non-member" bucket is built on it. Old documents
  // have no attendanceType; readers use resolveAttendanceType() as fallback.
  attendanceType: { type: String, enum: ['MEMBER', 'VISITOR', 'EMPLOYEE', 'GUEST'] },
  // Manila-local 'YYYY-MM-DD' of the check-in (reporting/grouping label). A
  // member may have SEVERAL sessions per day; this is NOT unique.
  dayKey: { type: String },
  // true while a MEMBER session is open (Time-In done, Time-Out pending), unset
  // once closed. A partial unique index on { userId } where openSession is true
  // is what makes "at most one open session per member" a database guarantee.
  openSession: { type: Boolean },
  // Set when a session from an earlier day was never timed out and was retired
  // so it would not block the member. Its checkOut stays empty (never invented).
  missedCheckOut: { type: Boolean },
  // Idempotency keys: a retried request with the same key returns the original
  // result instead of creating/closing a second time.
  requestId: { type: String },
  checkOutRequestId: { type: String },

  rfidCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard' },
  memberType: { type: String, enum: ['Regular', 'Student'], default: 'Regular' },
  checkIn: { type: Date },
  checkOut: { type: Date },
  notes: { type: String },
}, { timestamps: true });

// Fallback for legacy rows written before attendanceType existed. `card` is the
// populated rfidCardId (or null).
attendanceSchema.statics.resolveType = function (doc, card) {
  if (doc.attendanceType) return doc.attendanceType;
  if (doc.subjectType === 'employee' || doc.coachId) return 'EMPLOYEE';
  if (doc.userId) return 'MEMBER';
  if (card && card.cardType === 'TEMPORARY') return 'VISITOR';
  if (doc.notes === 'Visitor pass') return 'VISITOR';
  return 'GUEST';
};

attendanceSchema.index({ rfidCardId: 1, createdAt: -1 });
// At most ONE open session per member, at the database level.
attendanceSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { openSession: true }, name: 'one_open_session_per_member' },
);
// Member history lookups (all sessions, newest first).
attendanceSchema.index({ userId: 1, checkIn: -1 });
// Idempotency keys (partial: rows without a key are not indexed).
attendanceSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } }, name: 'attendance_request_id' });
attendanceSchema.index({ checkOutRequestId: 1 }, { unique: true, partialFilterExpression: { checkOutRequestId: { $type: 'string' } }, name: 'attendance_checkout_request_id' });

module.exports = mongoose.model('Attendance', attendanceSchema);