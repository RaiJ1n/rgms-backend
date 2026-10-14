// test/dailyDeduction.mongo.test.js - REAL MongoDB integration test of the
// atomic once-per-day deduction. It is SKIPPED unless MONGO_TEST_URI is set,
// and it refuses to run against any database whose name does not contain
// "test" (never point it at production). It creates and then deletes only its
// own documents. Run:
//   MONGO_TEST_URI="mongodb://127.0.0.1:27017/rgms_test" node --test test/dailyDeduction.mongo.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const URI = process.env.MONGO_TEST_URI;
const dbName = URI ? (URI.split('?')[0].split('/').pop() || '') : '';
const enabled = !!URI && /test/i.test(dbName);
const skip = enabled ? false : (URI ? 'MONGO_TEST_URI database name must contain "test"' : 'set MONGO_TEST_URI to run against a disposable MongoDB');

process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');

test('real MongoDB: concurrent first-of-day deductions charge once; legacy docs work', { skip }, async () => {
  const Subscription = require('../models/Subscription');
  const MembershipPlan = require('../models/MembershipPlan');
  const svc = require('../services/subscriptionService');
  await mongoose.connect(URI);
  const ids = { plan: new mongoose.Types.ObjectId(), user1: new mongoose.Types.ObjectId(), user2: new mongoose.Types.ObjectId() };
  try {
    await MembershipPlan.collection.insertOne({ _id: ids.plan, name: 'itest-plan', durationValue: 1, durationUnit: 'month' });
    // Raw insert: a LEGACY document that has no lastDeductedDayKey at all.
    await Subscription.collection.insertOne({ userId: ids.user1, planId: ids.plan, endDate: new Date(Date.now() + 864e7), sessionsUsed: 0 });
    await Subscription.collection.insertOne({ userId: ids.user2, planId: ids.plan, endDate: new Date(Date.now() + 864e7), sessionsUsed: 5 });

    const results = await Promise.all(Array.from({ length: 20 }, () => svc.recordAttendanceSession(ids.user1, { dayKey: '2026-10-14' })));
    assert.equal(results.filter((r) => r.deducted).length, 1);
    const s1 = await Subscription.collection.findOne({ userId: ids.user1 });
    assert.equal(s1.sessionsUsed, 1);
    assert.equal(s1.lastDeductedDayKey, '2026-10-14');

    // Legacy, already charged today by old code (sessionsUsed > 0, no marker), later session.
    const g = await svc.recordAttendanceSession(ids.user2, { dayKey: '2026-10-14', firstOfDay: false });
    assert.equal(g.reason, 'legacy_assumed_deducted');
    assert.equal((await Subscription.collection.findOne({ userId: ids.user2 })).sessionsUsed, 5);
    const next = await svc.recordAttendanceSession(ids.user2, { dayKey: '2026-10-15', firstOfDay: false });
    assert.equal(next.deducted, true);
  } finally {
    await Subscription.collection.deleteMany({ userId: { $in: [ids.user1, ids.user2] } });
    await MembershipPlan.collection.deleteOne({ _id: ids.plan });
    await mongoose.disconnect();
  }
});
