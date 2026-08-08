// One-time seed for the membership plans shown on Membership.vue.
//
// Run once with:  node scripts/seedPlans.js
//
// Expiration is calculated from durationValue + durationUnit (see
// services/subscriptionService.js) — NOT from the `duration` string,
// which is display-only now. Add new plans with any durationValue/
// durationUnit combo and they'll expire correctly with no other code
// changes required.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const MembershipPlan = require('../models/MembershipPlan');

const plans = [
  { name: 'Daily', duration: 'Daily Pass', durationValue: 1, durationUnit: 'day', price: 120, studentPrice: 100, description: '1 day access to gym' },
  { name: 'Weekly', duration: 'Weekly Pass', durationValue: 7, durationUnit: 'day', price: 800, studentPrice: 700, description: '7 days access to gym' },
  { name: 'Monthly', duration: 'Monthly Membership', durationValue: 1, durationUnit: 'month', price: 3000, studentPrice: 2500, description: '30 days access to gym' },
  { name: 'Yearly', duration: 'Annual Membership', durationValue: 1, durationUnit: 'year', price: 30000, studentPrice: 25000, description: '365 days access to gym' },
];

(async () => {
  await connectDB();

  for (const plan of plans) {
    const existing = await MembershipPlan.findOne({ name: plan.name });
    if (existing) {
      console.log(`Skipping "${plan.name}" — already exists`);
      continue;
    }
    await MembershipPlan.create(plan);
    console.log(`Created plan "${plan.name}"`);
  }

  await mongoose.connection.close();
  console.log('Done.');
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});