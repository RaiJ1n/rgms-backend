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

  rfidCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard' },
  memberType: { type: String, enum: ['Regular', 'Student'], default: 'Regular' },
  checkIn: { type: Date },
  checkOut: { type: Date },
  notes: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Attendance', attendanceSchema);