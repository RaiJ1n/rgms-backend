// services/rfidBinding.js
//
// ONE place that decides what an already-existing RFIDCard means when an admin
// tries to bind the same UID again. The REST register route, the bridge
// auto-bind (rfidController.autoBindCaptured) and the local-serial auto-bind
// (rfidService.handleRFIDData) all used to answer "already assigned to another
// account" for ANY existing document. That was wrong whenever the document's
// owner no longer exists: deleting a member (adminController.deleteMember)
// deliberately leaves the member's RFIDCard behind, and that orphan then blocked
// the physical card from ever being bound again.
//
//   SAME       - card belongs to the owner being bound      -> idempotent success
//   OTHER      - card belongs to a DIFFERENT, EXISTING owner -> reject (never overwrite)
//   TEMPORARY  - card is a visitor/spare pass                -> reject, different wording
//   ORPHAN     - owner id is set but no such User/Coach, or no owner at all
//                                                            -> safe to reclaim
const User = require('../models/User');
const Coach = require('../models/Coach');
const AuditLog = require('../models/AuditLog');

const KIND = { SAME: 'same', OTHER: 'other', TEMPORARY: 'temporary', ORPHAN: 'orphan' };

const MESSAGES = {
  same: 'This RFID card is already assigned to this account.',
  other: 'This RFID card is already assigned to another account.',
  temporary: 'This RFID card is registered as a visitor/temporary pass. Return or revoke the pass before binding it to a member.',
};

// An owner "exists" if the id is a real User or Coach. Coaches live in User
// (role: 'coach') in current data and in the legacy Coach model in older data,
// so check both - a false "orphan" would let a live coach's card be taken.
async function ownerExists(id) {
  if (!id) return false;
  const [user, coach] = await Promise.all([User.exists({ _id: id }), Coach.exists({ _id: id })]);
  return !!(user || coach);
}

// `existing` is an RFIDCard document; `target` is { userId, coachId } (strings).
async function classifyExisting(existing, target) {
  const sameId = (a, b) => !!a && !!b && String(a) === String(b);
  if (sameId(existing.userId, target.userId) || sameId(existing.coachId, target.coachId)) {
    return KIND.SAME;
  }
  if (existing.cardType === 'TEMPORARY') return KIND.TEMPORARY;
  const currentOwner = existing.userId || existing.coachId;
  if (currentOwner && (await ownerExists(currentOwner))) return KIND.OTHER;
  return KIND.ORPHAN;
}

// Re-points an orphaned card at the new owner. Only ever called after
// classifyExisting() returned ORPHAN. Leaves the UID/hash/cardId untouched.
async function reclaimOrphan(existing, { userId, coachId, adminId, via }) {
  const previousOwnerId = existing.userId || existing.coachId || null;
  existing.userId = userId || undefined;
  existing.coachId = coachId || undefined;
  existing.active = true;
  existing.assignedAt = new Date();
  await existing.save();
  await AuditLog.create({
    action: 'rfid_register',
    userId: adminId || undefined,
    meta: {
      cardId: existing.cardId,
      ownerId: userId || coachId,
      ownerType: userId ? 'member' : 'employee',
      reclaimedFromMissingOwner: previousOwnerId ? String(previousOwnerId) : null,
      via: via || 'register',
    },
  }).catch(() => {});
  return existing;
}

module.exports = { KIND, MESSAGES, ownerExists, classifyExisting, reclaimOrphan };
