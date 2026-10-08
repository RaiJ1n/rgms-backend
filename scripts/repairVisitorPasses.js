// scripts/repairVisitorPasses.js
//
// Safe data repair for the visitor-pass / attendance consistency fix.
// Run on the VPS, from the backend folder, with the production .env loaded.
//
//   node scripts/repairVisitorPasses.js            # DRY RUN: reports only, writes nothing
//   node scripts/repairVisitorPasses.js --apply    # performs the repairs below
//
// BACK UP THE DATABASE FIRST (mongodump). The script is additive and
// idempotent (safe to run twice); it never deletes or rewrites history.
//
// What it repairs
//   1. Attendance rows with no `attendanceType` get one (MEMBER / VISITOR /
//      EMPLOYEE / GUEST) using the same rules as Attendance.resolveType().
//   2. TEMPORARY (visitor) cards whose latest visit in Attendance has a
//      checkOut but whose card has no `checkedOutAt`  -> the "checkout exists
//      but status = ACTIVE, card unavailable" inconsistency. The card gets
//      checkedOutAt (and checkedInAt) copied from Attendance, which makes it
//      CHECKED_OUT and available for the next visitor.
//   3. TEMPORARY cards with a check-in but no checkOut yet -> checkedInAt only
//      (they are legitimately still ACTIVE / inside).
//
// Not touched: revoked cards, member/employee cards, attendance times.
const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  /* dotenv optional */
}
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();
  console.log(APPLY ? '*** APPLY MODE — writing changes ***' : '--- DRY RUN — nothing will be written (use --apply) ---');

  // ---- 1. attendanceType backfill -----------------------------------------
  const tempCardIds = (await RFIDCard.find({ cardType: 'TEMPORARY' }).select('_id').lean()).map((c) => c._id);
  const rules = [
    ['EMPLOYEE', { attendanceType: { $exists: false }, $or: [{ subjectType: 'employee' }, { coachId: { $ne: null } }] }],
    ['MEMBER', { attendanceType: { $exists: false }, userId: { $ne: null } }],
    ['VISITOR', { attendanceType: { $exists: false }, userId: null, $or: [{ rfidCardId: { $in: tempCardIds } }, { notes: 'Visitor pass' }] }],
    ['GUEST', { attendanceType: { $exists: false }, userId: null, coachId: null }], // whatever is left: manual walk-ins
  ];
  for (const [type, filter] of rules) {
    const n = await Attendance.countDocuments(filter);
    console.log(`attendanceType ${type}: ${n} row(s) to backfill`);
    if (APPLY && n) await Attendance.updateMany(filter, { $set: { attendanceType: type } });
  }

  // ---- 2 & 3. visitor card state ------------------------------------------
  const cards = await RFIDCard.find({ cardType: 'TEMPORARY' });
  let released = 0;
  let inside = 0;
  for (const card of cards) {
    if (card.checkedOutAt) continue;
    const since = card.assignedAt || card.validFrom || new Date(0);
    const latest = await Attendance.findOne({ rfidCardId: card._id, createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
    if (!latest) continue;
    if (latest.checkOut) {
      released += 1;
      console.log(`  card ${card.cardId} (${card.visitorName}): checked out ${latest.checkOut.toISOString()} but pass not marked -> will be CHECKED_OUT / available`);
      if (APPLY) await RFIDCard.updateOne({ _id: card._id, checkedOutAt: null }, { $set: { checkedInAt: latest.checkIn, checkedOutAt: latest.checkOut } });
    } else if (!card.checkedInAt) {
      inside += 1;
      if (APPLY) await RFIDCard.updateOne({ _id: card._id, checkedInAt: null }, { $set: { checkedInAt: latest.checkIn } });
    }
  }
  console.log(`visitor cards to release (checkout exists, was stuck ACTIVE): ${released}`);
  console.log(`visitor cards still inside (checkedInAt backfill only): ${inside}`);
  console.log(APPLY ? 'Done.' : 'Dry run complete — re-run with --apply after reviewing the numbers above.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
