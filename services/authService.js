const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const { generateResetToken, hashToken } = require('../utils/generateResetToken');

const registerUser = async ({ fullname, email, password, phone }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new Error('User already exists');
  }

  const user = await User.create({ fullname, email, password, phone });
  const token = generateToken({ id: user._id });
  return { user, token };
};

const loginUser = async ({ email, password }) => {
  const user = await User.findOne({ email });
  if (!user || !(await user.matchPassword(password))) {
    throw new Error('Invalid email or password');
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

module.exports = {
  registerUser,
  loginUser,
  createResetToken,
  resetPassword,
};
