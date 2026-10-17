// One-off migration

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const OLD_COACH_COLLECTION = 'coaches';

async function run() {
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

    // Insert the already-hashed password directly
    const user = new User({
      fullname: old.fullname,
      email,
      password: old.password,
      role: 'coach',
      specialization: old.specialization,
      isActive: old.isActive !== undefined ? old.isActive : true,
      isVerified: true,
      createdBy: old.createdBy,
      createdAt: old.createdAt,
    });
    await user.save({ validateBeforeSave: false });

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