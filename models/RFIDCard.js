const mongoose = require('mongoose');

const rfidCardSchema = new mongoose.Schema({
  // Card reference
  cardId: { type: String, required: true, unique: true, trim: true },

  // HMAC-SHA256(RFID_HASH_SECRET, normalized UID) — see utils/uidHash.js
  uidHash: { type: String, unique: true, sparse: true, select: false },

  // A card belongs to exactly one of these — never both
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach' },

  // Visitor / temporary pass support
  cardType: { type: String, enum: ['MEMBER', 'TEMPORARY'], default: 'MEMBER' },
  visitorName: { type: String, trim: true },
  validFrom: { type: Date },
  validUntil: { type: Date },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Visit state for a TEMPORARY card
  checkedInAt: { type: Date },
  checkedOutAt: { type: Date },

  active: { type: Boolean, default: true },
  lastScannedAt: { type: Date },
  lastSignalAt: { type: Date },
  assignedAt: { type: Date },
  // Set only while this spare card is lent to an existing MEMBER as a temporary replacement for a forgotten card (see TempCardAssignment)
  // Cleared when the loan is returned or revoked
  memberAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'TempCardAssignment' },
}, { timestamps: true });

// The keyed hash is an internal lookup key: never serialize it into an API response
rfidCardSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.uidHash;
    return ret;
  },
});

module.exports = mongoose.model('RFIDCard', rfidCardSchema);