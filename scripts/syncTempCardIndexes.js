// scripts/syncTempCardIndexes.js
// ADDITIVE ONLY: it never drops or rewrites data and never drops an existing index
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch (_) { }
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
