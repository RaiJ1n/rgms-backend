// One-off script to create a coach account.
// Run from your backend project root:
//   node scripts/seedCoach.js
//
// Uses User.create() (not a raw insert) so the pre('save') hook
// actually hashes the password — a raw db.users.insertOne() would
// store it in plain text and login would never match.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

// Adjust these before running:
const COACH = {
  fullname: 'John Russel Orias',
  email: 'johnrusselorias@gmail.com',
  password: 'changeme123', // gets bcrypt-hashed automatically
  role: 'coach',
  isActive: true,
};

async function run() {
  // If your config/db.js exports a connectDB() helper, prefer that
  // instead of this raw connect — swap the next line for
  // require('../config/db')() if so, to stay consistent with the
  // rest of the app's connection setup/logging/options.
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const existing = await User.findOne({ email: COACH.email });
  if (existing) {
    console.log(`A user with email ${COACH.email} already exists (role: "${existing.role}").`);
    console.log('Not creating a duplicate. Either delete that document first, or use a different email.');
  } else {
    const coach = await User.create(COACH);
    console.log('Coach created:', { id: coach._id, email: coach.email, role: coach.role });
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});