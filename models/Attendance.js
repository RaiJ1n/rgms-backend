const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rfidCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard' },
  checkIn: { type: Date },
  checkOut: { type: Date },
  notes: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
