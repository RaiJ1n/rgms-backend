// services/tempCardService.js
//
// Temporary RFID cards for EXISTING MEMBERS who forgot their own card.
// (Day-visitor passes live in visitorPassService / rfidController and are
// untouched; this service only adds the member-loan side and a combined
// inventory view.)
//
// A loan connects a spare card (RFIDCard cardType 'TEMPORARY') to an existing
// member through a TempCardAssignment. It never creates a member, a
// subscription or a visitor record, and it never modifies the member's
// original card. Attendance on tap is processed by attendanceService, which
// resolves the spare card to the member and applies the normal rules.
const mongoose = require('mongoose');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const TempCardAssignment = require('../models/TempCardAssignment');
const cardLookup = require('./rfidCardLookup');
const visitorPassService = require('./visitorPassService');
const attendanceService = require('./attendanceService');
const socketUtil = require('../utils/socket');
const escapeRegex = require('../utils/escapeRegex');
const { normalizeUid, isValidUid } = require('../utils/normalizeUid');
const { identityFor } = require('../utils/uidHash');
const { startOfLocalDay, endOfLocalDay, formatLocalDateLabel } = require('../utils/localDate');

const HOLDING = TempCardAssignment.HOLDING_STATUSES;

const httpError = (message, status = 400, errorType) => {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  if (errorType) e.errorType = errorType;
  return e;
};

const idOf = (v) => (v && v._id ? v._id : v);
const sameId = (a, b) => a != null && b != null && String(idOf(a)) === String(idOf(b));
const isObjectId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v) && /^[0-9a-fA-F]{24}$/.test(v);

// Everything that arrives in a request body is untrusted: strings only, so a
// payload like { "$ne": null } can never reach a query.
function cleanUid(raw, label) {
  if (typeof raw !== 'string' || !raw.trim()) throw httpError(`${label} is required`, 400);
  const uid = normalizeUid(raw);
  if (!isValidUid(uid)) throw httpError(`${label} is not a valid RFID UID`, 400);
  return uid;
}

// ----------------------------------------------------------------------------
// Housekeeping - run before anything that reads or decides on loan state.
// ----------------------------------------------------------------------------
// 1. A loan whose day ended becomes EXPIRED. It STILL holds the physical card:
//    the card is not available again until staff mark it returned.
// 2. Heals the one possible drift: assignment closed (RETURNED/REVOKED/
//    CANCELLED) but the card write that releases it was lost.
async function releaseCard(cardId, assignmentId) {
  await RFIDCard.updateOne(
    { _id: cardId, memberAssignmentId: assignmentId },
    { $unset: { memberAssignmentId: 1, lastScannedAt: 1, checkedInAt: 1, checkedOutAt: 1 } },
  );
}

async function sweepLoans(now = new Date()) {
  await TempCardAssignment.updateMany(
    { status: 'ACTIVE', expiresAt: { $lte: now } },
    { $set: { status: 'EXPIRED' } },
  );
  const loaned = await RFIDCard.find({ cardType: 'TEMPORARY', memberAssignmentId: { $ne: null } });
  for (const card of loaned) {
    const a = await TempCardAssignment.findById(card.memberAssignmentId);
    if (!a || !HOLDING.includes(a.status)) {
      await releaseCard(card._id, card.memberAssignmentId);
      card.memberAssignmentId = undefined;
    }
  }
}

// ----------------------------------------------------------------------------
// Presentation
// ----------------------------------------------------------------------------
function presentAssignment(a, extras = {}) {
  const o = a.toObject ? a.toObject() : a;
  const member = o.memberId && o.memberId.fullname ? o.memberId : null;
  const issuer = o.issuedBy && o.issuedBy.fullname ? o.issuedBy : null;
  const returner = o.returnedBy && o.returnedBy.fullname ? o.returnedBy : null;
  return {
    _id: o._id,
    type: 'MEMBER_TEMP',
    status: o.status,
    memberId: idOf(o.memberId),
    memberName: member ? member.fullname : extras.memberName,
    tempCardRef: extras.tempCardRef,
    originalCardRef: extras.originalCardRef,
    originalVerifiedBy: o.originalVerifiedBy,
    issuedAt: o.issuedAt,
    issuedByName: issuer ? issuer.fullname : undefined,
    expiresAt: o.expiresAt,
    returnedAt: o.returnedAt || null,
    returnedByName: returner ? returner.fullname : undefined,
    revokedReason: o.revokedReason || null,
  };
}

// ----------------------------------------------------------------------------
// Member search (issuance picker)
// ----------------------------------------------------------------------------
async function searchMembers(rawQuery, now = new Date()) {
  const q = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 60) : '';
  if (q.length < 2) return [];
  const or = [
    { fullname: { $regex: escapeRegex(q), $options: 'i' } },
    { email: { $regex: escapeRegex(q), $options: 'i' } },
  ];
  if (isObjectId(q)) or.push({ _id: q });
  const users = await User.find({ role: 'user', $or: or }).select('fullname email phone isActive').limit(10);
  await sweepLoans(now);

  const out = [];
  for (const u of users) {
    const eligibility = await attendanceService.checkMemberEligibility(u, now);
    const cards = await RFIDCard.find({ userId: u._id, active: true });
    const loan = await TempCardAssignment.findOne({ memberId: u._id, status: { $in: HOLDING } });
    const startOfDay = startOfLocalDay(now);
    const today = await Attendance.findOne({ userId: u._id, createdAt: { $gte: startOfDay } });
    out.push({
      _id: u._id,
      fullname: u.fullname,
      email: u.email,
      phone: u.phone,
      eligible: eligibility.ok,
      ineligibleReason: eligibility.ok ? null : eligibility.message,
      registeredCardRef: cards[0] ? cards[0].cardId : null,
      hasRegisteredCard: cards.length > 0,
      activeLoan: !!loan,
      attendanceToday: today ? (today.checkOut ? 'COMPLETED' : 'CHECKED_IN') : null,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Issue a spare card to a member
// ----------------------------------------------------------------------------
async function issueToMember({ memberId, tempUid, originalUid, originalNotPresent, adminId }, now = new Date()) {
  if (!isObjectId(memberId)) throw httpError('memberId is invalid', 400);
  const tempCardUid = cleanUid(tempUid, 'Temporary card UID');

  const member = await User.findOne({ _id: memberId, role: 'user' });
  if (!member) throw httpError('Member not found', 404);

  await sweepLoans(now);

  // 1. Eligibility - the SAME rules a tap on the member's own card uses.
  //    Issuing a card never repairs an expired / inactive / suspended membership.
  const eligibility = await attendanceService.checkMemberEligibility(member, now);
  if (!eligibility.ok) {
    throw httpError(
      `${eligibility.message}. A temporary card cannot make an ineligible membership valid.`,
      409, eligibility.errorType,
    );
  }

  // 2. Attendance rule: one visit per member per day. If they already have a
  //    visit today (inside, or completed) a spare card has no purpose.
  const today = await Attendance.findOne({ userId: member._id, createdAt: { $gte: startOfLocalDay(now) } });
  if (today) {
    throw httpError(
      today.checkOut
        ? `${member.fullname} already completed attendance today`
        : `${member.fullname} is already checked in today`,
      409, 'attendance_today_exists',
    );
  }

  // 3. One active loan per member (friendly message; the partial unique index
  //    is the real guarantee).
  const existingLoan = await TempCardAssignment.findOne({ memberId: member._id, status: { $in: HOLDING } });
  if (existingLoan) {
    throw httpError(
      existingLoan.status === 'EXPIRED'
        ? `${member.fullname} still has an unreturned temporary card from an earlier day. Mark it returned first.`
        : `${member.fullname} already has an active temporary card`,
      409, 'member_has_active_loan',
    );
  }

  // 4. The member's registered ORIGINAL card. It is only read, never changed.
  const memberCards = await RFIDCard.find({ userId: member._id, active: true });
  if (!memberCards.length) {
    throw httpError(`${member.fullname} has no active registered RFID card. Register a card first.`, 409, 'no_original_card');
  }
  let originalCard;
  let originalVerifiedBy;
  if (originalUid !== undefined && originalUid !== null && originalUid !== '') {
    const scanned = cleanUid(originalUid, 'Original card UID');
    const found = await cardLookup.findByUid(scanned);
    originalCard = found && memberCards.find((c) => sameId(c, found));
    if (!originalCard) {
      throw httpError('The scanned original card is not registered to this member', 409, 'original_card_mismatch');
    }
    originalVerifiedBy = 'scanned';
  } else if (originalNotPresent === true) {
    // Staff confirmed the card is physically absent. The registered card is
    // taken from the member's record and flagged as database-verified.
    originalCard = memberCards[0];
    originalVerifiedBy = 'database-record';
  } else {
    throw httpError('Scan the original card, or confirm that it is not present', 400, 'original_not_verified');
  }

  // 5. The spare card: must be a spare (never a member/employee card) and free.
  let spare = await cardLookup.findByUid(tempCardUid);
  if (spare) {
    if (spare.cardType !== 'TEMPORARY') {
      throw httpError('This card is registered to a member or employee and cannot be used as a temporary card', 409, 'not_a_spare_card');
    }
    if (spare.memberAssignmentId) {
      throw httpError('This card is currently lent to a member', 409, 'card_unavailable');
    }
    await visitorPassService.reconcilePass(spare);
    if (!visitorPassService.isCardAvailable(spare, now)) {
      throw httpError('This card is currently assigned to a visitor pass', 409, 'card_unavailable');
    }
  } else {
    // Unknown UID tapped by staff on purpose: it becomes a blank spare card.
    try {
      spare = await RFIDCard.create({ ...identityFor(tempCardUid), cardType: 'TEMPORARY', active: true });
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      spare = await cardLookup.findByUid(tempCardUid); // lost a creation race
      if (!spare || spare.cardType !== 'TEMPORARY') throw httpError('This card cannot be used as a temporary card', 409, 'card_unavailable');
    }
  }

  // 6. Create the assignment first: its unique indexes make a second loan for
  //    this member (or a second holder for this card) fail atomically.
  const assignmentId = new mongoose.Types.ObjectId();
  let assignment;
  try {
    assignment = await TempCardAssignment.create({
      _id: assignmentId,
      memberId: member._id,
      originalCardId: originalCard._id,
      originalVerifiedBy,
      tempCardId: spare._id,
      status: 'ACTIVE',
      issuedBy: adminId,
      issuedAt: now,
      expiresAt: endOfLocalDay(now), // end of today, Asia/Manila
    });
  } catch (err) {
    if (err && err.code === 11000) {
      throw httpError('This member or this card was just assigned by someone else. Refresh and try again.', 409, 'assignment_conflict');
    }
    throw err;
  }

  // 7. Claim the physical card atomically. The filter re-checks availability
  //    inside the write, so a visitor pass and a loan can never both win.
  const claimed = await RFIDCard.findOneAndUpdate(
    { _id: spare._id, ...visitorPassService.availableFilter(now) },
    {
      $set: { memberAssignmentId: assignmentId, active: true, assignedAt: now, issuedBy: adminId },
      $unset: { visitorName: 1, validFrom: 1, validUntil: 1, lastScannedAt: 1, checkedInAt: 1, checkedOutAt: 1 },
    },
    { new: true },
  );
  if (!claimed) {
    await TempCardAssignment.updateOne(
      { _id: assignmentId, status: 'ACTIVE' },
      { $set: { status: 'CANCELLED', holdsCard: false, revokedReason: 'card claim failed' } },
    );
    throw httpError('This card was just assigned to someone else. Choose a different card.', 409, 'card_unavailable');
  }

  await AuditLog.create({
    action: 'rfid_member_temp_issued',
    userId: adminId,
    meta: {
      assignmentId, memberId: member._id, tempCard: spare.cardId,
      originalCard: originalCard.cardId, originalVerifiedBy,
    },
  }).catch(() => {});
  socketUtil.emitToAdmins('temp-card:changed', { type: 'issued', assignmentId });

  return presentAssignment(assignment, {
    memberName: member.fullname,
    tempCardRef: spare.cardId,
    originalCardRef: originalCard.cardId,
  });
}

// ----------------------------------------------------------------------------
// End a loan: return (card handed back) or revoke (stop it now, with a reason).
// Neither touches the member's subscription or attendance history.
// ----------------------------------------------------------------------------
async function endAssignment(assignmentId, { status, adminId, reason }, now = new Date()) {
  const ended = await TempCardAssignment.findOneAndUpdate(
    { _id: assignmentId, status: { $in: HOLDING } },
    {
      $set: {
        status, holdsCard: false, returnedAt: now, returnedBy: adminId,
        ...(status === 'REVOKED' ? { revokedReason: reason } : {}),
      },
    },
    { new: true },
  );
  if (!ended) throw httpError('This temporary card assignment is not active', 409, 'not_active');
  await releaseCard(ended.tempCardId, ended._id);
  const card = await RFIDCard.findById(ended.tempCardId);
  const member = await User.findById(ended.memberId).select('fullname');
  await AuditLog.create({
    action: status === 'REVOKED' ? 'rfid_member_temp_revoked' : 'rfid_member_temp_returned',
    userId: adminId,
    meta: { assignmentId: ended._id, memberId: ended.memberId, tempCard: card && card.cardId, reason },
  }).catch(() => {});
  socketUtil.emitToAdmins('temp-card:changed', { type: status.toLowerCase(), assignmentId: ended._id });
  return presentAssignment(ended, { tempCardRef: card && card.cardId, memberName: member ? member.fullname : undefined });
}

// Return by card (staff tap the card, or pick it from the inventory).
// Works for both kinds of spare card:
//   member loan   -> assignment RETURNED, card released
//   visitor pass  -> only if the visitor is NOT currently inside; an unused
//                    pass is cancelled so the card is free again
async function returnCard({ id, uid, adminId }, now = new Date()) {
  let card;
  if (id !== undefined) {
    if (!isObjectId(id)) throw httpError('id is invalid', 400);
    card = await RFIDCard.findById(id);
  } else {
    card = await cardLookup.findByUid(cleanUid(uid, 'Card UID'));
  }
  if (!card || card.cardType !== 'TEMPORARY') throw httpError('Temporary card not found', 404);

  if (card.memberAssignmentId) {
    const loan = await TempCardAssignment.findById(card.memberAssignmentId);
    if (!loan || !HOLDING.includes(loan.status)) {
      // The loan is already closed (double submit, stale screen, or a lost card
      // write). The card is free, so heal the pointer and report it - this is a
      // harmless no-op, not a conflict.
      await releaseCard(card._id, card.memberAssignmentId);
      return { alreadyAvailable: true, cardRef: card.cardId };
    }
    try {
      return await endAssignment(card.memberAssignmentId, { status: 'RETURNED', adminId }, now);
    } catch (err) {
      // Lost a race with another return of the same card: if it is now closed
      // as RETURNED, the outcome is exactly what the caller wanted.
      if (err && err.errorType === 'not_active') {
        const latest = await TempCardAssignment.findById(card.memberAssignmentId);
        if (!latest || !HOLDING.includes(latest.status)) {
          await releaseCard(card._id, card.memberAssignmentId);
          return { alreadyAvailable: true, cardRef: card.cardId };
        }
      }
      throw err;
    }
  }

  await visitorPassService.reconcilePass(card);
  const st = visitorPassService.passStatus(card, now);
  if (st === 'ACTIVE') {
    throw httpError('This visitor is still checked in. Check them out first, then return the card.', 409, 'visitor_inside');
  }
  if (visitorPassService.RELEASED_STATUSES.includes(st)) {
    return { alreadyAvailable: true, cardRef: card.cardId };
  }
  // PENDING / UPCOMING: issued but never used - cancel it, keep the record.
  const cancelled = await RFIDCard.findOneAndUpdate(
    { _id: card._id, checkedInAt: null, active: true, memberAssignmentId: null },
    { $set: { active: false } },
    { new: true },
  );
  if (!cancelled) throw httpError('This pass changed while returning it. Refresh and try again.', 409, 'conflict');
  await AuditLog.create({
    action: 'rfid_visitor_pass_returned',
    userId: adminId,
    meta: { cardId: card.cardId, visitorName: card.visitorName },
  }).catch(() => {});
  socketUtil.emitToAdmins('temp-card:changed', { type: 'returned', cardId: card._id });
  return { alreadyAvailable: false, cardRef: card.cardId, visitorPass: visitorPassService.presentPass(cancelled, now) };
}

async function revokeAssignment({ assignmentId, reason, adminId }, now = new Date()) {
  if (!isObjectId(assignmentId)) throw httpError('assignment id is invalid', 400);
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) throw httpError('A reason is required to revoke a temporary card', 400);
  if (r.length > 200) throw httpError('Reason is too long (max 200 characters)', 400);
  return endAssignment(assignmentId, { status: 'REVOKED', adminId, reason: r }, now);
}

// ----------------------------------------------------------------------------
// Inventory: every spare card with its CURRENT state.
//   AVAILABLE  nobody holds it
//   ASSIGNED   issued (member loan, or visitor pass not yet used)
//   IN_USE     the holder is currently checked in
//   EXPIRED    a member loan whose day ended but the card is not back yet
// How the last holder's use ended (checked out / revoked / returned) is
// history, shown as lastOutcome on available cards - not a separate state.
// ----------------------------------------------------------------------------
async function listInventory({ state, limit = 100 } = {}, now = new Date()) {
  await sweepLoans(now);
  const cards = await RFIDCard.find({ cardType: 'TEMPORARY' }).sort({ updatedAt: -1 }).limit(Math.min(200, Math.max(1, limit)));
  const rows = [];
  for (const card of cards) {
    if (card.memberAssignmentId) {
      const a = await TempCardAssignment.findById(card.memberAssignmentId);
      if (!a) continue;
      const member = await User.findById(a.memberId).select('fullname');
      const open = await Attendance.findOne({ rfidCardId: card._id, createdAt: { $gte: a.issuedAt }, checkOut: { $exists: false } });
      rows.push({
        cardId: card._id, cardRef: card.cardId, type: 'MEMBER_TEMP',
        state: a.status === 'EXPIRED' ? 'EXPIRED' : (open ? 'IN_USE' : 'ASSIGNED'),
        assignmentId: a._id, holderName: member ? member.fullname : null,
        issuedAt: a.issuedAt, expiresAt: a.expiresAt, returnedAt: null, issuedBy: a.issuedBy || null,
        actions: ['return', 'revoke'],
      });
      continue;
    }
    await visitorPassService.reconcilePass(card);
    const st = visitorPassService.passStatus(card, now);
    if (st === 'UNASSIGNED') {
      const last = await TempCardAssignment.findOne({ tempCardId: card._id }).sort({ issuedAt: -1 });
      rows.push({
        cardId: card._id, cardRef: card.cardId, type: null, state: 'AVAILABLE',
        lastOutcome: last ? last.status : null, holderName: null,
        issuedAt: null, expiresAt: null, returnedAt: last ? last.returnedAt || null : null, issuedBy: null,
        actions: ['issue'],
      });
      continue;
    }
    const available = visitorPassService.RELEASED_STATUSES.includes(st);
    rows.push({
      cardId: card._id, cardRef: card.cardId, type: 'DAY_VISITOR',
      state: available ? 'AVAILABLE' : (st === 'ACTIVE' ? 'IN_USE' : 'ASSIGNED'),
      lastOutcome: available ? st : null,
      assignmentId: null, holderName: card.visitorName || null,
      issuedAt: card.assignedAt || card.createdAt, expiresAt: card.validUntil || null,
      returnedAt: card.checkedOutAt || null, issuedBy: card.issuedBy || null,
      actions: available ? ['issue'] : (st === 'ACTIVE' ? [] : ['return', 'revoke']),
    });
  }
  const wanted = typeof state === 'string' ? state.toUpperCase() : '';
  return ['AVAILABLE', 'ASSIGNED', 'IN_USE', 'EXPIRED'].includes(wanted) ? rows.filter((r) => r.state === wanted) : rows;
}

module.exports = {
  issueToMember, returnCard, revokeAssignment, searchMembers, listInventory,
  sweepLoans, presentAssignment, httpError,
};