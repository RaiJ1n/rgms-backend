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
  // Manila-local 'YYYY-MM-DD' of the check-in. Written for MEMBER rows only and
  // backed by a partial unique index (below) so two concurrent taps - on the
  // same card or on a member's original + temporary card - cannot create two
  // attendance rows (and two session deductions) for one member on one day.
  // Rows written before this field existed simply have no dayKey.
  dayKey: { type: String },

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
attendanceSchema.index(
  { userId: 1, dayKey: 1 },
  { unique: true, partialFilterExpression: { attendanceType: 'MEMBER', dayKey: { $type: 'string' } } },
);

module.exports = mongoose.model('Attendance', attendanceSchema);