const mongoose = require('mongoose');

const rfidCardSchema = new mongoose.Schema({
  // Card reference. For cards bound before UID hashing was enabled this is the
  // raw UID; for cards bound after (or after scripts/migrateRfidHash.js
  // --redact) it is an opaque CARD-XXXXXXXXXXXX reference. Either way it is
  // what lists, audit logs and the LCD show.
  cardId: { type: String, required: true, unique: true, trim: true },

  // HMAC-SHA256(RFID_HASH_SECRET, normalized UID) — see utils/uidHash.js.
  // Sparse so cards that have not been migrated yet don't collide on null.
  // select:false keeps it out of every API response by default.
  uidHash: { type: String, unique: true, sparse: true, select: false },

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

  // Visitor / temporary pass support (additive — every field is optional, so
  // existing member/employee cards need NO migration). A missing cardType
  // means MEMBER. Code must treat "cardType !== 'TEMPORARY'" as a normal
  // card; never query { cardType: 'MEMBER' } (old documents don't have it).
  //
  // A TEMPORARY card is bound to neither userId nor coachId, so it can never
  // become a member, never gets a subscription, and never passes the normal
  // member checks. It is valid only between validFrom and validUntil (one
  // Manila-local calendar day). "Expired" is derived from validUntil at scan
  // time — nothing has to run at midnight — and `active: false` means REVOKED.
  cardType: { type: String, enum: ['MEMBER', 'TEMPORARY'], default: 'MEMBER' },
  visitorName: { type: String, trim: true },
  validFrom: { type: Date },
  validUntil: { type: Date },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  active: { type: Boolean, default: true },
  lastScannedAt: { type: Date },
  assignedAt: { type: Date },
}, { timestamps: true });

// The keyed hash is an internal lookup key: never serialize it into an API
// response, even for a freshly created document (where select:false doesn't apply).
rfidCardSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.uidHash;
    return ret;
  },
});

module.exports = mongoose.model('RFIDCard', rfidCardSchema);