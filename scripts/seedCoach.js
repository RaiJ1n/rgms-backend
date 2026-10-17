// One-off script to create a coach account

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

// Adjust these before running

async function run() {
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