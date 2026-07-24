const mongoose = require('mongoose');

const rfidCardSchema = new mongoose.Schema({
  cardId: { type: String, required: true, unique: true, trim: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  active: { type: Boolean, default: true },
  lastScannedAt: { type: Date },
  assignedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('RFIDCard', rfidCardSchema);
