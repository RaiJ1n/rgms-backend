// services/rfidCardLookup.js
//
// The only place that decides how a tapped UID (or an admin-supplied card
// reference) is matched to an RFIDCard document. Dual-read on purpose: a card
// matches by its keyed hash OR by a legacy raw cardId, so production cards that
// were bound before hashing was switched on keep working.
const RFIDCard = require('../models/RFIDCard');
const { normalizeUid } = require('../utils/normalizeUid');
const { hashUid, OPAQUE_REF } = require('../utils/uidHash');

// `uid` must already be a normalized, validated UID. Returns a Mongoose Query
// (so callers can keep chaining .populate()).
function findByUid(uid) {
  const hash = hashUid(uid);
  return RFIDCard.findOne(hash ? { $or: [{ uidHash: hash }, { cardId: uid }] } : { cardId: uid });
}

// For routes shaped /:cardId — the admin UI passes whatever it has: the opaque
// reference of a hashed card, or a UID for a legacy/manual lookup.
function findByCardParam(param) {
  const s = String(param || '').trim().toUpperCase();
  if (OPAQUE_REF.test(s)) return RFIDCard.findOne({ cardId: s });
  return findByUid(normalizeUid(s));
}

// Normalizes a route param without destroying an opaque reference
// (normalizeUid would strip its dash).
function paramToRef(param) {
  const s = String(param || '').trim().toUpperCase();
  return OPAQUE_REF.test(s) ? s : normalizeUid(s);
}

module.exports = { findByUid, findByCardParam, paramToRef };