const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const { generateOtp, hashOtp } = require('../utils/generateOtp');
const emailService = require('./emailService');

const httpError = (message, statusCode) => { const e = new Error(message); e.statusCode = statusCode; return e; };

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;

const createAdmin = async ({ fullname, email, password, phone }) => {
  const existing = await User.findOne({ email });
  if (existing) {
    throw new Error('Admin already exists');
  }

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

// Password-change OTP (Admin Settings)

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
  // Overwriting these is what invalidates any previously issued code — there is only ever one valid
  admin.passwordChangeOtp = hashedOtp;
  admin.passwordChangeOtpExpires = new Date(Date.now() + OTP_TTL_MS);
  admin.passwordChangeOtpLastSentAt = new Date();
  await admin.save();

  try {
    await emailService.sendPasswordChangeOtpEmail(admin, otp);
  } catch (err) {
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

  admin.password = newPassword;
  admin.lastPasswordChange = new Date();
  // Single-use
  admin.passwordChangeOtp = undefined;
  admin.passwordChangeOtpExpires = undefined;
  admin.passwordChangeOtpLastSentAt = undefined;
  await admin.save();

  return admin;
};

// Auto-provisions the very first admin from .env on server boot, if none exists yet
// This does NOT change how login works: it still creates a real User document with a real bcrypt-hashed password
const ensureDefaultAdmin = async () => {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULLNAME } = process.env;

  if (!ADMIN_EMAIL && !ADMIN_PASSWORD && !ADMIN_FULLNAME) return;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !ADMIN_FULLNAME) {
    console.warn('[admin bootstrap] ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_FULLNAME must all be set together in .env — skipping auto-provision.');
    return;
  }

  const existingAdminCount = await User.countDocuments({ role: 'admin' });
  if (existingAdminCount > 0) return;

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
    password: ADMIN_PASSWORD,
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