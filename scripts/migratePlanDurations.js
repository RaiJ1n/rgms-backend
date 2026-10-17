// One-time migration
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const MembershipPlan = require('../models/MembershipPlan');

// Maps old free-text `duration` labels to the new numeric fields
const legacyDurationMap = {
  'daily pass': { durationValue: 1, durationUnit: 'day' },
  'weekly pass': { durationValue: 7, durationUnit: 'day' },
  'monthly membership': { durationValue: 1, durationUnit: 'month' },
  'annual membership': { durationValue: 1, durationUnit: 'year' },
};

(async () => {
  await connectDB();

  const plans = await MembershipPlan.find({
    $or: [{ durationValue: { $exists: false } }, { durationUnit: { $exists: false } }],
  });

  if (plans.length === 0) {
    console.log('No plans need migration — all plans already have durationValue/durationUnit.');
    await mongoose.connection.close();
    return;
  }

  let migrated = 0;
  let skipped = 0;

  for (const plan of plans) {
    const key = (plan.duration || '').trim().toLowerCase();
    const match = legacyDurationMap[key];

    if (!match) {
      console.warn(
        `⚠️  Could not auto-migrate plan "${plan.name}" (duration: "${plan.duration}") — ` +
        `unrecognized label. Set durationValue/durationUnit for it manually in Admin Settings.`
      );
      skipped += 1;
      continue;
    }

    plan.durationValue = match.durationValue;
    plan.durationUnit = match.durationUnit;
    await plan.save();
    console.log(`✓ Migrated "${plan.name}" → ${match.durationValue} ${match.durationUnit}(s)`);
    migrated += 1;
  }

  console.log(`\nDone. Migrated: ${migrated}, needs manual review: ${skipped}.`);
  await mongoose.connection.close();
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});