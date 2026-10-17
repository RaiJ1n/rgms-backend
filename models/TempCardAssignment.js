const mongoose = require('mongoose');

// A spare RFID card lent to an EXISTING member who forgot their own card
// Lifecycle: ACTIVE -> RETURNED | REVOKED (staff action) ACTIVE -> EXPIRED -> RETURNED | REVOKED
const HOLDING_STATUSES = ['ACTIVE', 'EXPIRED'];
// `holdsCard` mirrors "status is ACTIVE or EXPIRED" as a plain boolean

const tempCardAssignmentSchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // The member's registered card at issue time
  originalCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard', required: true },
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

// Database-level guarantees (the service also checks first, for friendly errors)
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
