// services/visitorPassService.js
//
// Single place that defines what a visitor pass's STATUS is and when its
// physical RFID card is AVAILABLE for another visitor.
//
// A visitor pass is an RFIDCard with cardType 'TEMPORARY' (there is no
// separate VisitorPass collection). Its lifecycle:
//
//   issued ──► PENDING/UPCOMING ──check-in──► ACTIVE ──check-out──► CHECKED_OUT
//                                                                      │
//                                         card is AVAILABLE again ◄────┘
//
// Source of truth: the card document (active, validFrom/Until, checkedInAt,
// checkedOutAt). Those two timestamps are written in the SAME operation as the
// Attendance check-in/out (attendanceService.js), and reconcilePass() repairs
// the only possible drift (attendance closed but card write lost).
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');

// Precedence (highest first): REVOKED > CHECKED_OUT > EXPIRED > UPCOMING >
// ACTIVE (inside) / PENDING (valid, not used yet).
// CHECKED_OUT deliberately outranks "still inside the validity window".
function passStatus(card, now = new Date()) {
  if (!card.active) return 'REVOKED';
  if (card.checkedOutAt) return 'CHECKED_OUT';
  if (card.validUntil && now > card.validUntil) return 'EXPIRED';
  if (card.validFrom && now < card.validFrom) return 'UPCOMING';
  return card.checkedInAt ? 'ACTIVE' : 'PENDING';
}

// A card can be handed to a new visitor once its visit is over (checked out),
// revoked, or its day has passed. It can NOT be re-issued while it is
// PENDING / UPCOMING / ACTIVE — a pass validity date ending is not what
// releases a card that is still live; a checkout is.
const RELEASED_STATUSES = ['CHECKED_OUT', 'EXPIRED', 'REVOKED'];
function isCardAvailable(card, now = new Date()) {
  return RELEASED_STATUSES.includes(passStatus(card, now));
}

// Mongo filter equivalent of isCardAvailable() — used for the atomic
// re-issue so two admins can never both claim the same card.
function availableFilter(now = new Date()) {
  return {
    cardType: 'TEMPORARY',
    $or: [
      { active: false },
      { checkedOutAt: { $ne: null } },
      { validUntil: { $lt: now } },
    ],
  };
}

function presentPass(card, now = new Date()) {
  const o = card.toObject ? card.toObject() : card;
  const status = passStatus(o, now);
  return {
    _id: o._id,
    cardId: o.cardId,
    visitorName: o.visitorName,
    status,
    cardAvailable: RELEASED_STATUSES.includes(status),
    validFrom: o.validFrom,
    validUntil: o.validUntil,
    checkedInAt: o.checkedInAt || null,
    checkedOutAt: o.checkedOutAt || null,
    lastScannedAt: o.lastScannedAt,
    issuedAt: o.assignedAt || o.createdAt,
  };
}

// Repairs a card whose attendance was closed but whose own checkedOutAt was
// never written (legacy rows, or a failed second write). Attendance is the
// record of what physically happened, so it wins. Returns the (possibly
// updated) card document.
async function reconcilePass(card) {
  if (!card || card.cardType !== 'TEMPORARY' || card.checkedOutAt || !card.active) return card;
  const since = card.assignedAt || card.validFrom || new Date(0);
  const latest = await Attendance.findOne({ rfidCardId: card._id, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .lean();
  if (!latest) return card;
  const patch = {};
  if (!card.checkedInAt && latest.checkIn) patch.checkedInAt = latest.checkIn;
  if (latest.checkOut) patch.checkedOutAt = latest.checkOut;
  if (!Object.keys(patch).length) return card;
  await RFIDCard.updateOne({ _id: card._id, checkedOutAt: null }, { $set: patch });
  Object.assign(card, patch);
  return card;
}

module.exports = { passStatus, isCardAvailable, availableFilter, presentPass, reconcilePass, RELEASED_STATUSES };
