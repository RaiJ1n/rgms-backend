const User = require('../models/User');
const Notification = require('../models/Notification');
const socketUtil = require('../utils/socket');
const generateToken = require('../utils/generateToken');
const { generateResetToken, hashToken } = require('../utils/generateResetToken');
const { generateVerificationToken, hashVerificationToken } = require('../utils/generateVerificationToken');

const registerUser = async ({ fullname, email, password, phone, address }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new Error('User already exists');
  }

  const user = await User.create({ fullname, email, password, phone, address });

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
  if (!user || !(await user.matchPassword(password))) {
    throw new Error('Invalid email or password');
  }
  if (!user.isActive) {
    const err = new Error('This account has been deactivated. Please contact the gym.');
    err.statusCode = 403;
    throw err;
  }
  const token = generateToken({ id: user._id });
  return { user, token };
};

const createResetToken = async (user) => {
  const { resetToken, hashedToken } = generateResetToken();
  user.resetPasswordToken = hashedToken;
  user.resetPasswordExpires = Date.now() + 60 * 60 * 1000;
  await user.save();
  return resetToken;
};

const resetPassword = async ({ token, password }) => {
  const hashedToken = hashToken(token);
  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpires: { $gt: Date.now() },
  });
  if (!user) throw new Error('Invalid or expired reset token');
  user.password = password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
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
  createResetToken,
  resetPassword,
  createVerificationToken,
  verifyEmail,
  resendVerification,
};