// scripts/syncAttendanceIndexes.js
// WHY THIS MUST RUN BEFORE (or together with) the new backend: An earlier release added a unique index userId_1_dayKey_1
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch (_) { }
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Attendance = require('../models/Attendance');
const { startOfLocalDay } = require('../utils/localDate');

const OLD_INDEX = 'userId_1_dayKey_1';
const OLD_KEY = { userId: 1, dayKey: 1 };
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Names of the indexes this release declares (plus _id_)
const EXPECTED = new Set(['_id_', 'one_open_session_per_member', 'attendance_request_id', 'attendance_checkout_request_id']);

(async () => {
  const apply = process.argv.includes('--apply');
  await connectDB();
  const coll = Attendance.collection;

  const existing = await coll.indexes().catch(() => []);
  console.log('Existing indexes (full spec):');
  existing.forEach((i) => console.log(`  - ${i.name}  key=${JSON.stringify(i.key)}  unique=${!!i.unique}  sparse=${!!i.sparse}  partial=${JSON.stringify(i.partialFilterExpression || null)}`));

  const oldByName = existing.find((i) => i.name === OLD_INDEX);
  const hasOld = !!oldByName && sameKey(oldByName.key, OLD_KEY) && !!oldByName.unique;
  if (oldByName && !hasOld) {
    console.error(`REFUSING to touch "${OLD_INDEX}": its key/uniqueness is not the expected {userId:1,dayKey:1} unique. Inspect it by hand.`);
    process.exit(2);
  }
  console.log(hasOld
    ? `Found the old one-row-per-day index "${OLD_INDEX}" (key ${JSON.stringify(oldByName.key)}, unique) - it ${apply ? 'will be dropped' : 'WOULD be dropped'}.`
    : `Old index "${OLD_INDEX}" not present - nothing to drop.`);

  const suspicious = existing.filter((i) => i.unique && !EXPECTED.has(i.name) && i.name !== OLD_INDEX);
  suspicious.forEach((i) => console.warn(`WARNING: unexpected UNIQUE index "${i.name}" key=${JSON.stringify(i.key)} partial=${JSON.stringify(i.partialFilterExpression || null)} - NOT touched; check it does not block several sessions per day.`));

  // Informational only
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