// scripts/syncAttendanceIndexes.js
//
// Switches the Attendance collection from "one row per member per day" to
// "many sessions per day, at most ONE OPEN session per member".
//
// WHY THIS MUST RUN BEFORE (or together with) the new backend:
//   An earlier release added a unique index  userId_1_dayKey_1  (one MEMBER row
//   per member per day). If it is still in the database, a member's SECOND
//   session of the day is rejected with E11000 even though the code now allows
//   it. Mongoose never drops indexes on its own, so it has to be dropped here.
//
// What it does (and does not do):
//   - drops ONLY the index named userId_1_dayKey_1, if present
//   - creates the new indexes (open-session guard, idempotency keys, history)
//   - never deletes or rewrites an attendance document
//   - the new unique indexes are PARTIAL (only rows carrying openSession /
//     requestId), so existing rows cannot make index creation fail
//
// BACK UP FIRST (mongodump of `attendances`, `subscriptions`, `rfidcards`), then:
//   node scripts/syncAttendanceIndexes.js          # dry run: shows what it would do
//   node scripts/syncAttendanceIndexes.js --apply  # does it
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch (_) { /* dotenv optional */ }
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Attendance = require('../models/Attendance');
const { startOfLocalDay } = require('../utils/localDate');

const OLD_INDEX = 'userId_1_dayKey_1';

(async () => {
  const apply = process.argv.includes('--apply');
  await connectDB();
  const coll = Attendance.collection;

  const existing = await coll.indexes().catch(() => []);
  const hasOld = existing.some((i) => i.name === OLD_INDEX);
  console.log(`Existing indexes: ${existing.map((i) => i.name).join(', ') || '(none)'}`);
  console.log(hasOld
    ? `Found the old one-row-per-day index "${OLD_INDEX}" - it ${apply ? 'will be dropped' : 'WOULD be dropped'}.`
    : `Old index "${OLD_INDEX}" not present - nothing to drop.`);

  // Informational only: member sessions still open from before today. They have
  // no openSession flag, so they are treated as open for today and retired as
  // "missed time-out" (time-out left empty) the next time that member checks in
  // on a later day. No data is changed by this script.
  const todayStart = startOfLocalDay();
  const legacyOpenToday = await Attendance.countDocuments({ userId: { $ne: null }, checkOut: { $exists: false }, createdAt: { $gte: todayStart } });
  const legacyOpenOlder = await Attendance.countDocuments({ userId: { $ne: null }, checkOut: { $exists: false }, createdAt: { $lt: todayStart } });
  console.log(`Member rows with no time-out: ${legacyOpenToday} from today (members currently inside), ${legacyOpenOlder} from earlier days (missed time-outs; left as they are).`);

  console.log('\nIndexes the model declares:');
  Attendance.schema.indexes().forEach(([keys, opts]) => console.log(`  - ${JSON.stringify(keys)} ${opts.name || ''} ${JSON.stringify(opts.partialFilterExpression || {})}`));

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to make the changes.');
  } else {
    if (hasOld) { await coll.dropIndex(OLD_INDEX); console.log(`Dropped ${OLD_INDEX}`); }
    await Attendance.createIndexes();
    console.log('Created/verified the new indexes.');
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error('Index sync failed:', err.message);
  process.exit(1);
});
