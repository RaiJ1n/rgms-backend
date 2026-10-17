const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  // Member attendance (unchanged)
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  guestName: { type: String, trim: true },

  // Employee/coach attendance (new)
  coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach' },

  subjectType: { type: String, enum: ['member', 'employee'], default: 'member' },

  attendanceType: { type: String, enum: ['MEMBER', 'VISITOR', 'EMPLOYEE', 'GUEST'] },
  // Manila-local 'YYYY-MM-DD' of the check-in (reporting/grouping label)
  dayKey: { type: String },
  openSession: { type: Boolean },
  // Set when a session from an earlier day was never timed out and was retired
  // Set when a session from an earlier day was never timed out and was retired so it would not block the member
  missedCheckOut: { type: Boolean },
  // Idempotency keys
  requestId: { type: String },
  checkOutRequestId: { type: String },

  rfidCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard' },
  memberType: { type: String, enum: ['Regular', 'Student'], default: 'Regular' },
  checkIn: { type: Date },
  checkOut: { type: Date },
  notes: { type: String },
}, { timestamps: true });

// Fallback for legacy rows written before attendanceType existed
attendanceSchema.statics.resolveType = function (doc, card) {
  if (doc.attendanceType) return doc.attendanceType;
  if (doc.subjectType === 'employee' || doc.coachId) return 'EMPLOYEE';
  if (doc.userId) return 'MEMBER';
  if (card && card.cardType === 'TEMPORARY') return 'VISITOR';
  if (doc.notes === 'Visitor pass') return 'VISITOR';
  return 'GUEST';
};

attendanceSchema.index({ rfidCardId: 1, createdAt: -1 });
// At most ONE open session per member, at the database level
attendanceSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { openSession: true }, name: 'one_open_session_per_member' },
);
// Member history lookups (all sessions, newest first)
attendanceSchema.index({ userId: 1, checkIn: -1 });
// Idempotency keys
attendanceSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } }, name: 'attendance_request_id' });
attendanceSchema.index({ checkOutRequestId: 1 }, { unique: true, partialFilterExpression: { checkOutRequestId: { $type: 'string' } }, name: 'attendance_checkout_request_id' });

module.exports = mongoose.model('Attendance', attendanceSchema);