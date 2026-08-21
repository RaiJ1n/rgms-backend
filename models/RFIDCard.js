const mongoose = require('mongoose');

const rfidCardSchema = new mongoose.Schema({
  cardId: { type: String, required: true, unique: true, trim: true },

  // A card belongs to exactly one of these — never both. Kept as two
  // separate optional fields rather than a single polymorphic
  // {ownerType, ownerId} pair so every existing query/populate against
  // `userId` (rfidController, attendanceService, EditMember.vue's bind
  // flow, etc.) keeps working completely unchanged for member cards.
  // The mutual-exclusivity rule itself is enforced in the controller
  // (registerCard), not the schema — consistent with how this codebase
  // already handles cross-field validation elsewhere (e.g. Payment's
  // conditional referenceNumber requirement lives in the controller/route
  // layer, not the model).
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach' },

  active: { type: Boolean, default: true },
  lastScannedAt: { type: Date },
  assignedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('RFIDCard', rfidCardSchema);