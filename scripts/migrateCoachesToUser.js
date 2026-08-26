// One-off migration: moves any coach accounts still sitting in the old,
// disconnected `Coach` collection into the `User` collection with
// role: 'coach', which is the only collection the unified
// POST /auth/login actually authenticates against.
//
// Background: coachController.createCoach used to call Coach.create(),
// a separate model from User. authService.loginUser only ever does
// User.findOne({ email }), so any coach created before this fix was
// saved successfully but could never log in. That controller now
// creates User documents directly (role: 'coach'), same as seedCoach.js
// already did — but any coaches created BEFORE that fix are still
// stranded in the old Coach collection and need this one-time move.
//
// Run from your backend project root:
//   node scripts/migrateCoachesToUser.js
//
// Safe to re-run: any Coach document whose email already exists in
// User is skipped rather than duplicated or overwritten.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
// Old model — still exported as `{}` post-deprecation, so we read the
// raw collection directly rather than importing models/Coach.js.
// Adjust the collection name below if your old Coach model didn't use
// the default pluralized 'coaches' collection name.
const OLD_COACH_COLLECTION = 'coaches';

async function run() {
  // If your config/db.js exports a connectDB() helper, prefer that
  // instead of this raw connect, to stay consistent with the rest of
  // the app's connection setup/logging/options.
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const oldCoaches = await mongoose.connection.db.collection(OLD_COACH_COLLECTION).find({}).toArray();

  if (oldCoaches.length === 0) {
    console.log(`No documents found in the old "${OLD_COACH_COLLECTION}" collection. Nothing to migrate.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`Found ${oldCoaches.length} coach record(s) in the old collection.`);

  let migrated = 0;
  let skipped = 0;

  for (const old of oldCoaches) {
    const email = (old.email || '').toLowerCase();
    const existing = await User.findOne({ email });

    if (existing) {
      console.log(`Skipping ${email} — already exists in User (role: "${existing.role}").`);
      skipped += 1;
      continue;
    }

    // Insert the already-hashed password directly (bypassing the
    // pre('save') hook) rather than re-hashing an already-bcrypt string
    // through User.create() — hashing a hash would break the coach's
    // existing password. They keep logging in with the same password
    // they were given originally.
    const user = new User({
      fullname: old.fullname,
      email,
      password: old.password, // already bcrypt-hashed by the old Coach model's own pre('save')
      role: 'coach',
      specialization: old.specialization,
      isActive: old.isActive !== undefined ? old.isActive : true,
      isVerified: true,
      createdBy: old.createdBy,
      createdAt: old.createdAt,
    });
    await user.save({ validateBeforeSave: false }); // password is already hashed; skip minlength re-check on the hash itself

    console.log(`Migrated ${email} -> User (${user._id})`);
    migrated += 1;
  }

  console.log(`\nDone. Migrated: ${migrated}, skipped (already existed): ${skipped}.`);
  console.log(
    `Once you've confirmed the migrated coaches can log in, you can drop the old "${OLD_COACH_COLLECTION}" collection.`
  );

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});