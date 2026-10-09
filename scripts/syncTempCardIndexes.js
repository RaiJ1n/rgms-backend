// scripts/syncTempCardIndexes.js
//
// Creates the indexes the temporary-card feature relies on. ADDITIVE ONLY:
// it never drops or rewrites data and never drops an existing index.
//
//   TempCardAssignment (new, empty collection)
//     one_active_per_member  unique {memberId}   where status = 'ACTIVE'
//     one_holder_per_card    unique {tempCardId} where holdsCard = true
//   Attendance
//     unique {userId, dayKey} where attendanceType = 'MEMBER' and dayKey is a string
//     (partial: existing rows have no dayKey, so none of them are indexed)
//
// BACK UP FIRST (mongodump of rfidcards, attendances, subscriptions), then:
//   node scripts/syncTempCardIndexes.js          # prints what it will create
//   node scripts/syncTempCardIndexes.js --apply  # creates the indexes
//
// Mongoose's autoIndex would also build these at server start; running this
// first (against staging, then production) makes the moment explicit and lets
// you see any failure before the new code is live.
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch (_) { /* dotenv optional */ }
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Attendance = require('../models/Attendance');
const TempCardAssignment = require('../models/TempCardAssignment');

(async () => {
  const apply = process.argv.includes('--apply');
  await connectDB();
  for (const [name, Model] of [['Attendance', Attendance], ['TempCardAssignment', TempCardAssignment]]) {
    const wanted = Model.schema.indexes().map(([keys, opts]) => `${JSON.stringify(keys)} ${JSON.stringify(opts.partialFilterExpression || {})}`);
    console.log(`${name}: ${wanted.length} index(es) declared`);
    wanted.forEach((w) => console.log(`  - ${w}`));
    if (apply) {
      await Model.createIndexes();
      console.log(`  created/verified`);
    }
  }
  if (!apply) console.log('\nDry run only. Re-run with --apply to create them.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('Index sync failed:', err.message);
  process.exit(1);
});
