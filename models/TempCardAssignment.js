const mongoose = require('mongoose');

// A spare RFID card lent to an EXISTING member who forgot their own card.
// This is an alternative credential, not an identity: the member, their
// subscription and their original card are all untouched. A tap on the spare
// card resolves to `memberId` through an ACTIVE assignment and then goes
// through the normal member attendance rules.
//
// Lifecycle:  ACTIVE -> RETURNED | REVOKED          (staff action)
//             ACTIVE -> EXPIRED -> RETURNED | REVOKED  (day ended, card not back yet)
//             ACTIVE -> CANCELLED                    (issuance lost a race; never effective)
// ACTIVE and EXPIRED both still "hold" the physical card, so it is not
// available again until it is returned or revoked.
const HOLDING_STATUSES = ['ACTIVE', 'EXPIRED'];
// `holdsCard` mirrors "status is ACTIVE or EXPIRED" as a plain boolean so the
// unique index below only needs an equality filter (works on every MongoDB
// version; $in in a partial filter needs 6.0+). Set false whenever the
// assignment ends (RETURNED / REVOKED / CANCELLED).

const tempCardAssignmentSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The member's registered card at issue time. Reference only - never modified.
  originalCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard', required: true },
  // 'scanned'         = the original card was tapped on the reader and matched
  // 'database-record' = staff confirmed the card is not present; the
  //                     registered card was taken from the member's record
  originalVerifiedBy: { type: String, enum: ['scanned', 'database-record'], required: true },
  tempCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard', required: true },
  status: { type: String, enum: ['ACTIVE', 'EXPIRED', 'RETURNED', 'REVOKED', 'CANCELLED'], default: 'ACTIVE', index: true },
  holdsCard: { type: Boolean, default: true },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  issuedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  returnedAt: { type: Date },
  returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokedReason: { type: String, trim: true, maxlength: 200 },
}, { timestamps: true });

// Database-level guarantees (the service also checks first, for friendly errors):
//  - a member has at most one ACTIVE temporary card
//  - a spare card is held by at most one unreturned assignment
// Lookup index (a different key from the unique one below on purpose: older
// MongoDB versions refuse two indexes on the same key that differ only in options).
tempCardAssignmentSchema.index({ memberId: 1, issuedAt: -1 });
tempCardAssignmentSchema.index(
  { memberId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_per_member' },
);
tempCardAssignmentSchema.index(
  { tempCardId: 1 },
  { unique: true, partialFilterExpression: { holdsCard: true }, name: 'one_holder_per_card' },
);

const TempCardAssignment = mongoose.model('TempCardAssignment', tempCardAssignmentSchema);
TempCardAssignment.HOLDING_STATUSES = HOLDING_STATUSES;
module.exports = TempCardAssignment;
