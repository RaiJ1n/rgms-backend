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

module.exports = {
  createAdmin,
  loginAdmin,
  getAdmins,
  requestPasswordChangeOtp,
  verifyAndChangePassword,
};