// Password-change OTP for the Client and Coach "Change Password" flows
const User = require('../models/User');
const { generateOtp, hashOtp } = require('../utils/generateOtp');
const emailService = require('./emailService');

const httpError = (message, statusCode) => { const e = new Error(message); e.statusCode = statusCode; return e; };

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;

const requestPasswordChangeOtp = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw httpError('User not found', 404);

  if (user.passwordChangeOtpLastSentAt) {
    const elapsed = Date.now() - user.passwordChangeOtpLastSentAt.getTime();
    if (elapsed < OTP_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000);
      throw httpError(`Please wait ${waitSeconds}s before requesting another code`, 429);
    }
  }

  const { otp, hashedOtp } = generateOtp();
  // Overwriting these is what invalidates any previously issued code — there is only ever one valid
  user.passwordChangeOtp = hashedOtp;
  user.passwordChangeOtpExpires = new Date(Date.now() + OTP_TTL_MS);
  user.passwordChangeOtpLastSentAt = new Date();
  await user.save();

  try {
    await emailService.sendPasswordChangeOtpEmail(user, otp);
  } catch (err) {
    throw httpError('Failed to send verification code. Please try again.', 502);
  }

  return { sentTo: user.email, expiresInSeconds: OTP_TTL_MS / 1000 };
};

const verifyAndChangePassword = async ({ userId, currentPassword, newPassword, otp }) => {
  const user = await User.findById(userId);
  if (!user) throw httpError('User not found', 404);

  const currentPasswordMatches = await user.matchPassword(currentPassword);
  if (!currentPasswordMatches) {
    throw httpError('Current password is incorrect', 401);
  }

  if (!user.passwordChangeOtp || !user.passwordChangeOtpExpires) {
    throw httpError('No verification code was requested. Please click Send Code first.', 400);
  }
  if (user.passwordChangeOtpExpires.getTime() < Date.now()) {
    throw httpError('This code has expired. Please request a new one.', 400);
  }
  if (hashOtp(otp) !== user.passwordChangeOtp) {
    throw httpError('Invalid verification code', 400);
  }

  user.password = newPassword;
  user.lastPasswordChange = new Date();
  // Single-use
  user.passwordChangeOtp = undefined;
  user.passwordChangeOtpExpires = undefined;
  user.passwordChangeOtpLastSentAt = undefined;
  await user.save();

  return user;
};

module.exports = {
  requestPasswordChangeOtp,
  verifyAndChangePassword,
};
