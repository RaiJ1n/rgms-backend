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
//   TEMPORARY  - visitor/spare card still IN USE (lent to a member, visitor
//                inside, pass still valid)                  -> reject
//   SPARE      - visitor/spare card that has been RETURNED / checked out /
//                expired / revoked, so nobody holds it      -> convert to a member card
//   ORPHAN     - owner id is set but no such User/Coach, or no owner at all
//                                                            -> safe to reclaim
const User = require('../models/User');
const visitorPassService = require('./visitorPassService');
const Coach = require('../models/Coach');
const TempCardAssignment = require('../models/TempCardAssignment');
const AuditLog = require('../models/AuditLog');

const KIND = { SAME: 'same', OTHER: 'other', TEMPORARY: 'temporary', SPARE: 'spare', ORPHAN: 'orphan' };

// Kinds that may be re-pointed at the new owner (nobody currently holds the card).
const isReclaimable = (kind) => kind === KIND.ORPHAN || kind === KIND.SPARE;

const MESSAGES = {
  same: 'This RFID card is already assigned to this account.',
  other: 'This RFID card is already assigned to another account.',
  temporary: 'This RFID card is currently in use as a temporary card (lent to a member or a visitor pass is still active). Return it or check the visitor out before binding it to a member.',
};

// An owner "exists" if the id is a real User or Coach. Coaches live in User
// (role: 'coach') in current data and in the legacy Coach model in older data,
// so check both - a false "orphan" would let a live coach's card be taken.
async function ownerExists(id) {
  if (!id) return false;
  // models/Coach.js may be an empty stub (coaches are Users with role 'coach'),
  // so only ask it if it really is a Mongoose model.
  const legacyCoach = typeof Coach.exists === 'function' ? Coach.exists({ _id: id }) : null;
  const [user, coach] = await Promise.all([User.exists({ _id: id }), legacyCoach]);
  return !!(user || coach);
}

// `existing` is an RFIDCard document; `target` is { userId, coachId } (strings).
async function classifyExisting(existing, target) {
  const sameId = (a, b) => !!a && !!b && String(a) === String(b);
  if (sameId(existing.userId, target.userId) || sameId(existing.coachId, target.coachId)) {
    return KIND.SAME;
  }
  if (existing.cardType === 'TEMPORARY') {
    // Never while lent to a member. Otherwise only once its pass is released
    // (returned / checked out / expired / revoked / never issued).
    if (existing.memberAssignmentId) {
      // Only a loan that is genuinely still open blocks binding. A pointer to a
      // closed (RETURNED / REVOKED / missing) loan is stale drift: nobody holds
      // the card. Fail closed if the loan cannot be read.
      let loan;
      try {
        loan = await TempCardAssignment.findById(existing.memberAssignmentId);
      } catch {
        return KIND.TEMPORARY;
      }
      if (loan && TempCardAssignment.HOLDING_STATUSES.includes(loan.status)) return KIND.TEMPORARY;
      existing.memberAssignmentId = undefined; // becomes a plain spare; reclaimOrphan clears the rest
    }
    return visitorPassService.isCardAvailable(existing) ? KIND.SPARE : KIND.TEMPORARY;
  }
  const currentOwner = existing.userId || existing.coachId;
  if (currentOwner && (await ownerExists(currentOwner))) return KIND.OTHER;
  return KIND.ORPHAN;
}

// Re-points an orphaned card at the new owner. Only ever called after
// classifyExisting() returned ORPHAN. Leaves the UID/hash/cardId untouched.
async function reclaimOrphan(existing, { userId, coachId, adminId, via }) {
  const previousOwnerId = existing.userId || existing.coachId || null;
  const wasSpare = existing.cardType === 'TEMPORARY';
  if (wasSpare) {
    // Becomes a normal member/employee card: drop every visitor/loan field.
    // (Old attendance rows keep their rfidCardId; new rows carry attendanceType.)
    existing.cardType = 'MEMBER';
    for (const f of ['visitorName', 'validFrom', 'validUntil', 'checkedInAt', 'checkedOutAt', 'memberAssignmentId', 'issuedBy', 'lastScannedAt']) {
      existing[f] = undefined;
    }
  }
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
      convertedFromTemporaryCard: wasSpare,
      via: via || 'register',
    },
  }).catch(() => {});
  return existing;
}

module.exports = { KIND, MESSAGES, isReclaimable, ownerExists, classifyExisting, reclaimOrphan };