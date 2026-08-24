const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const { generateOtp, hashOtp } = require('../utils/generateOtp');
const emailService = require('./emailService');

const httpError = (message, statusCode) => { const e = new Error(message); e.statusCode = statusCode; return e; };

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches the email copy
const OTP_COOLDOWN_MS = 60 * 1000; // 60 seconds between Send Code / Resend

const createAdmin = async ({ fullname, email, password, phone }) => {
  const existing = await User.findOne({ email });
  if (existing) {
    throw new Error('Admin already exists');
  }

  // Create as a regular User but set role to 'admin'
  const admin = await User.create({ fullname, email, password, phone, role: 'admin' });
  const token = generateToken({ id: admin._id });
  return { admin, token };
};

const loginAdmin = async ({ email, password }) => {
  const admin = await User.findOne({ email, role: 'admin' });

  if (!admin || !(await admin.matchPassword(password))) {
    throw httpError('Invalid email or password', 401);
  }

  const token = generateToken({ id: admin._id });
  return { admin, token };
};

const getAdmins = async () => {
  return User.find({ role: 'admin' }).select('-password');
};

// ---- Password-change OTP (Admin Settings) ----

const requestPasswordChangeOtp = async (adminId) => {
  const admin = await User.findById(adminId);
  if (!admin) throw httpError('Admin not found', 404);

  if (admin.passwordChangeOtpLastSentAt) {
    const elapsed = Date.now() - admin.passwordChangeOtpLastSentAt.getTime();
    if (elapsed < OTP_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000);
      throw httpError(`Please wait ${waitSeconds}s before requesting another code`, 429);
    }
  }

  const { otp, hashedOtp } = generateOtp();
  // Overwriting these is what invalidates any previously issued code —
  // there is only ever one valid (hash, expiry) pair stored at a time,
  // so a Resend automatically kills the earlier code.
  admin.passwordChangeOtp = hashedOtp;
  admin.passwordChangeOtpExpires = new Date(Date.now() + OTP_TTL_MS);
  admin.passwordChangeOtpLastSentAt = new Date();
  await admin.save();

  try {
    await emailService.sendPasswordChangeOtpEmail(admin, otp);
  } catch (err) {
    // Don't leave the admin thinking a code is on its way if the send
    // actually failed — surface it distinctly from a generic 500.
    throw httpError('Failed to send verification code. Please try again.', 502);
  }

  return { sentTo: admin.email, expiresInSeconds: OTP_TTL_MS / 1000 };
};

const verifyAndChangePassword = async ({ adminId, currentPassword, newPassword, otp }) => {
  const admin = await User.findById(adminId);
  if (!admin) throw httpError('Admin not found', 404);

  const currentPasswordMatches = await admin.matchPassword(currentPassword);
  if (!currentPasswordMatches) {
    throw httpError('Current password is incorrect', 401);
  }

  if (!admin.passwordChangeOtp || !admin.passwordChangeOtpExpires) {
    throw httpError('No verification code was requested. Please click Send Code first.', 400);
  }
  if (admin.passwordChangeOtpExpires.getTime() < Date.now()) {
    throw httpError('This code has expired. Please request a new one.', 400);
  }
  if (hashOtp(otp) !== admin.passwordChangeOtp) {
    throw httpError('Invalid verification code', 400);
  }

  admin.password = newPassword; // pre-save hook rehashes
  admin.lastPasswordChange = new Date();
  // Single-use: clearing these means the same code (even if still
  // within its expiry window) can never be matched again.
  admin.passwordChangeOtp = undefined;
  admin.passwordChangeOtpExpires = undefined;
  admin.passwordChangeOtpLastSentAt = undefined;
  await admin.save();

  return admin;
};

// Auto-provisions the very first admin from .env on server boot, if none
// exists yet — same idea as subscriptionService.js's ensureDefaultPlans().
// This does NOT change how login works: it still creates a real User
// document with a real bcrypt-hashed password (via the same pre-save
// hook every other account uses), logged in through the normal
// POST /admin/auth/login endpoint. It's purely a replacement for having
// to remember to run `node scripts/seedAdmin.js` by hand — the .env
// values are only ever read once, at the moment this creates the row;
// changing .env afterward does nothing to an admin that already exists.
//
// Deliberately NOT a login-time credential check against .env — that
// would be a hardcoded backdoor: a deactivated/deleted admin could still
// "log in" as long as the old .env values matched, and it would sidestep
// every DB-level control (isActive, password changes, deletion) this
// app already enforces. This only ever touches the database at boot,
// never during a login attempt.
const ensureDefaultAdmin = async () => {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULLNAME } = process.env;

  // All three unset is the normal case for anyone not using this feature
  // — stay silent rather than nagging every boot.
  if (!ADMIN_EMAIL && !ADMIN_PASSWORD && !ADMIN_FULLNAME) return;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_FULLNAME) {
    console.warn('[admin bootstrap] ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_FULLNAME must all be set together in .env — skipping auto-provision.');
    return;
  }

  const existingAdminCount = await User.countDocuments({ role: 'admin' });
  if (existingAdminCount > 0) return; // bootstrap only, same rule seedAdmin.js and requireAdminIfExists both enforce

  const existingEmail = await User.findOne({ email: ADMIN_EMAIL.toLowerCase() });
  if (existingEmail) {
    console.warn(`[admin bootstrap] A user with email "${ADMIN_EMAIL}" already exists (role: ${existingEmail.role}) — skipping auto-provision. Choose a different ADMIN_EMAIL or create the admin from Admin Settings once logged in another way.`);
    return;
  }

  if (ADMIN_PASSWORD.length < 8) {
    console.warn('[admin bootstrap] ADMIN_PASSWORD must be at least 8 characters — skipping auto-provision.');
    return;
  }

  await User.create({
    fullname: ADMIN_FULLNAME,
    email: ADMIN_EMAIL.toLowerCase(),
    password: ADMIN_PASSWORD, // pre-save hook hashes it, same as any other User
    role: 'admin',
    isVerified: true,
  });

  console.log(`[admin bootstrap] Created first admin account from .env: ${ADMIN_FULLNAME} <${ADMIN_EMAIL}>`);
};

module.exports = {
  createAdmin,
  loginAdmin,
  getAdmins,
  requestPasswordChangeOtp,
  verifyAndChangePassword,
  ensureDefaultAdmin,
};