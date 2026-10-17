// services/visitorPassService.js
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');

// Precedence (highest first)
function isUnassigned(card) {
  return !card.memberAssignmentId && !card.visitorName && !card.validFrom && !card.validUntil;
}

function passStatus(card, now = new Date()) {
  if (card.memberAssignmentId) return 'MEMBER_LOAN';
  if (!card.active) return 'REVOKED';
  if (isUnassigned(card)) return 'UNASSIGNED';
  if (card.checkedOutAt) return 'CHECKED_OUT';
  if (card.validUntil && now > card.validUntil) return 'EXPIRED';
  if (card.validFrom && now < card.validFrom) return 'UPCOMING';
  return card.checkedInAt ? 'ACTIVE' : 'PENDING';
}

// A card can be handed to a new visitor once its visit is over (checked out), revoked
// A card can be handed to a new visitor once its visit is over (checked out), revoked, or its day has passed
const RELEASED_STATUSES = ['CHECKED_OUT', 'EXPIRED', 'REVOKED', 'UNASSIGNED'];
function isCardAvailable(card, now = new Date()) {
  return RELEASED_STATUSES.includes(passStatus(card, now));
}

// Mongo filter equivalent of isCardAvailable() — used for the atomic re-issue
function availableFilter(now = new Date()) {
  return {
    cardType: 'TEMPORARY',
    memberAssignmentId: null,
    $or: [
      { active: false },
      { checkedOutAt: { $ne: null } },
      { validUntil: { $lt: now } },
      { validUntil: null, visitorName: null },
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

// Repairs a card whose attendance was closed but whose own checkedOutAt was never written
async function reconcilePass(card) {
  if (!card || card.cardType !== 'TEMPORARY' || card.checkedOutAt || !card.active) return card;
  // Member loans and blank spares have no visitor visit to repair
  if (card.memberAssignmentId || isUnassigned(card)) return card;
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

module.exports = { isUnassigned, passStatus, isCardAvailable, availableFilter, presentPass, reconcilePass, RELEASED_STATUSES };
