/**
 * check_duplicate_payment_ids.js
 *
 * Run this BEFORE deploying the `unique: true` change on
 * Subscription.paymentId. It finds any paymentId that appears on more
 * than one Subscription document — those would make MongoDB's unique
 * index build fail (or, if the index doesn't exist yet, represent
 * exactly the double-extension bug requirement #9 was guarding against).
 *
 * Usage:
 *   node check_duplicate_payment_ids.js
 *
 * Reads MONGODB_URI from your .env the same way config/db.js does,
 * falling back to the same local default. Does NOT modify any data —
 * read-only report.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Subscription = require('../models/Subscription');

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/gym-system';

async function main() {
  await mongoose.connect(uri);
  console.log(`Connected to ${uri}\n`);

  const duplicates = await Subscription.aggregate([
    {
      $group: {
        _id: '$paymentId',
        count: { $sum: 1 },
        subscriptionIds: { $push: '$_id' },
        userIds: { $push: '$userId' },
        endDates: { $push: '$endDate' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  if (duplicates.length === 0) {
    console.log('✅ No duplicate paymentId values found.');
    console.log('   Safe to deploy the unique index on Subscription.paymentId.');
  } else {
    console.log(`⚠️  Found ${duplicates.length} paymentId(s) shared by multiple subscriptions:\n`);
    for (const dup of duplicates) {
      console.log(`paymentId: ${dup._id}`);
      console.log(`  occurrences: ${dup.count}`);
      for (let i = 0; i < dup.subscriptionIds.length; i++) {
        console.log(
          `    - subscription ${dup.subscriptionIds[i]} | user ${dup.userIds[i]} | endDate ${dup.endDates[i].toISOString()}`
        );
      }
      console.log('');
    }
    console.log('These must be resolved before the unique index will build.');
    console.log('Typical fix: keep the subscription with the latest endDate for');
    console.log('each duplicated paymentId, and delete or re-point the others');
    console.log('after confirming with the affected users\' actual payment history.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Error checking for duplicates:', err);
  process.exit(1);
});