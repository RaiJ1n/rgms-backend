const User = require('../models/User');
const Notification = require('../models/Notification');
const socketUtil = require('../utils/socket');
const generateToken = require('../utils/generateToken');
const { generateOtp, hashOtp } = require('../utils/generateOtp');
const { generateVerificationToken, hashVerificationToken } = require('../utils/generateVerificationToken');

const registerUser = async ({ fullname, email, password, phone, address, privacyNoticeAcknowledged }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new Error('User already exists');
  }

  const user = await User.create({
    fullname,
    email,
    password,
    phone,
    address,
    privacyNoticeAcknowledged: !!privacyNoticeAcknowledged,
    privacyNoticeAcknowledgedAt: privacyNoticeAcknowledged ? new Date() : undefined,
  });

  // Fire-and-forget for the admin notification bell — a failure here
  // shouldn't block registration itself.
  Notification.create({
    type: 'signup',
    message: `${user.fullname} just signed up`,
    userId: user._id,
  })
    .then((notification) => socketUtil.emitToAdmins('notification:new', notification))
    .catch((err) => console.error('Failed to create signup notification:', err.message));

  // A new signup moves member-count stats (Statistics.vue's visitor
  // breakdown, admin member totals) — 'stats:refresh' just tells any open
  // admin dashboard "refetch when convenient", it carries no payload.
  socketUtil.emitToAdmins('stats:refresh');

  const token = generateToken({ id: user._id });
  return { user, token };
};

const loginUser = async ({ email, password }) => {
  const user = await User.findOne({ email });
  const httpError = (message, statusCode) => { const e = new Error(message); e.statusCode = statusCode; return e; };

  if (!user || !(await user.matchPassword(password))) {
    throw httpError('Invalid email or password', 401);
  }
  if (!user.isActive) {
    const err = new Error('This account has been deactivated. Please contact the gym.');
    err.statusCode = 403;
    throw err;
  }
  const token = generateToken({ id: user._id, tokenVersion: user.tokenVersion || 0 });
  return { user, token };
};

// Called from authController.logout, which runs behind `protect` so
// req.user is available. Bumping tokenVersion means the token that was
// just used to make this very request — and any other token issued
// before this moment — stops passing the check in authMiddleware/
// coachAuthMiddleware immediately, regardless of its 7-day expiry.
// This is the actual server-side "log out everywhere" the frontend
// clearing localStorage alone can't provide.
const logoutUser = async (userId) => {
  await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
};

const createForgotPasswordOtp = async (user) => {
  const { otp, hashedOtp } = generateOtp();
  user.forgotPasswordOtp = hashedOtp;
  // Shorter-lived than the old link (was 60 min) — a 6-digit code is
  // guessable in a way a 32-byte token isn't, so it shouldn't stay valid
  // as long. Matches the existing passwordChangeOtp convention.
  user.forgotPasswordOtpExpires = Date.now() + 10 * 60 * 1000;
  await user.save();
  return otp;
};

// Checks the code without consuming it, so the "Enter code" screen can
// confirm validity before the user has typed a new password. resetPassword
// below re-runs this same check (and only it clears the code on success),
// so a code that's merely been *verified* but never used to actually
// reset anything is still rejected once it expires.
const verifyForgotPasswordOtp = async ({ email, otp }) => {
  const hashedOtp = hashOtp(otp);
  const user = await User.findOne({
    email,
    forgotPasswordOtp: hashedOtp,
    forgotPasswordOtpExpires: { $gt: Date.now() },
  });
  if (!user) throw new Error('Invalid or expired code');
  return user;
};

const resetPassword = async ({ email, otp, password }) => {
  const user = await verifyForgotPasswordOtp({ email, otp });
  user.password = password;
  user.forgotPasswordOtp = undefined;
  user.forgotPasswordOtpExpires = undefined;
  // Anyone else holding a token issued before this reset (e.g. the
  // account was compromised, which is often why a reset happens)
  // shouldn't stay logged in past it.
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  return user;
};

// ---- Email verification ----

const createVerificationToken = async (user) => {
  const { verificationToken, hashedToken } = generateVerificationToken();
  user.verificationToken = hashedToken;
  user.verificationTokenExpires = Date.now() + 24 * 60 * 60 * 1000; // 24h
  await user.save();
  return verificationToken;
};

const verifyEmail = async (token) => {
  const hashedToken = hashVerificationToken(token);
  const user = await User.findOne({
    verificationToken: hashedToken,
    verificationTokenExpires: { $gt: Date.now() },
  });
  if (!user) throw new Error('Invalid or expired verification token');

  user.isVerified = true;
  user.verificationToken = undefined;
  user.verificationTokenExpires = undefined;
  await user.save();
  return user;
};

const resendVerification = async (email) => {
  const user = await User.findOne({ email });
  if (!user) throw new Error('User not found');
  if (user.isVerified) throw new Error('Email already verified');

  const verificationToken = await createVerificationToken(user);
  return { user, verificationToken };
};

module.exports = {
  registerUser,
  loginUser,
  logoutUser,
  createForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPassword,
  createVerificationToken,
  verifyEmail,
  resendVerification,
};