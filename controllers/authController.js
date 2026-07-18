const { validationResult } = require('express-validator');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const generateToken = require('../utils/generateToken');
const User = require('../models/User');

const register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { fullname, email, password, phone } = req.body;
    const { user, token } = await authService.registerUser({ fullname, email, password, phone });
    await emailService.sendWelcomeEmail(user);
    const safeUser = user.toObject();
    delete safeUser.password;
    res.status(201).json({ success: true, message: 'User registered', data: { user: safeUser, token } });
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { email, password } = req.body;
    const { user, token } = await authService.loginUser({ email, password });
    const safeUser = user.toObject();
    delete safeUser.password;
    res.json({ success: true, message: 'Login successful', data: { user: safeUser, token } });
  } catch (error) {
    next(error);
  }
};

const logout = async (req, res) => {
  res.json({ success: true, message: 'Logout successful' });
};

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const resetToken = await authService.createResetToken(user);
    const resetUrl = `${process.env.CLIENT_URL}/reset-password/${resetToken}`;
    await emailService.sendForgotPasswordEmail(user, resetUrl);

    res.json({ success: true, message: 'Reset password email sent' });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    const user = await authService.resetPassword({ token, password });
    const authToken = generateToken({ id: user._id });
    res.json({ success: true, message: 'Password reset successful', data: { token: authToken } });
  } catch (error) {
    next(error);
  }
};

module.exports = { register, login, logout, forgotPassword, resetPassword };
