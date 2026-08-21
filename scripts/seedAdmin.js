// One-time bootstrap for the very first admin account.
//
// Replaces the old public /admin/signup page (Section E of the
// requirements checklist: "public users must not be able to freely
// register as Admin" — a page reachable by anyone who knew the URL
// couldn't satisfy that, no matter what the backend enforced). Every
// admin account after this first one is created from inside
// AdminSettings.vue by an already-authenticated admin, via the existing
// POST /admin/auth/register endpoint (still guarded by
// adminBootstrapMiddleware.requireAdminIfExists, unchanged).
//
// Run once with:
//   ADMIN_EMAIL=you@gym.com ADMIN_PASSWORD=... ADMIN_FULLNAME="Your Name" node scripts/seedAdmin.js
//
// Credentials are read from the environment rather than hardcoded in this
// file (unlike seedPlans.js's plan data, which is non-sensitive) — a
// password sitting in a script is a password sitting in git history.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

(async () => {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULLNAME, ADMIN_PHONE } = process.env;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_FULLNAME) {
    console.error('Set ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_FULLNAME before running this script.');
    console.error('Example: ADMIN_EMAIL=you@gym.com ADMIN_PASSWORD=... ADMIN_FULLNAME="Your Name" node scripts/seedAdmin.js');
    process.exit(1);
  }
  if (ADMIN_PASSWORD.length < 8) {
    console.error('ADMIN_PASSWORD must be at least 8 characters (same rule User.js enforces everywhere else).');
    process.exit(1);
  }

  await connectDB();

  // Bootstrap only — refuses once any admin already exists, same rule
  // adminBootstrapMiddleware.requireAdminIfExists already enforces on the
  // API route this script is standing in for. Additional admins are
  // created via AdminSettings.vue by a logged-in admin, not this script.
  const existingAdminCount = await User.countDocuments({ role: 'admin' });
  if (existingAdminCount > 0) {
    console.log(`Skipping — ${existingAdminCount} admin account(s) already exist. Create additional admins from Admin Settings while logged in, not this script.`);
    await mongoose.connection.close();
    return;
  }

  const existingEmail = await User.findOne({ email: ADMIN_EMAIL.toLowerCase() });
  if (existingEmail) {
    console.error(`A user with email "${ADMIN_EMAIL}" already exists (role: ${existingEmail.role}). Choose a different ADMIN_EMAIL.`);
    process.exit(1);
  }

  const admin = await User.create({
    fullname: ADMIN_FULLNAME,
    email: ADMIN_EMAIL.toLowerCase(),
    password: ADMIN_PASSWORD, // pre-save hook hashes it, same as any other User
    phone: ADMIN_PHONE || undefined,
    role: 'admin',
    isVerified: true,
  });

  console.log(`Created first admin account: ${admin.fullname} <${admin.email}>`);
  console.log('Log in at /admin/login. Create any further admins from Admin Settings.');

  await mongoose.connection.close();
  console.log('Done.');
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});