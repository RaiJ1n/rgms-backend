const { validationResult } = require('express-validator');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const generateToken = require('../utils/generateToken');
const User = require('../models/User');

const register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { fullname, email, password, phone, address } = req.body;
    const { user, token } = await authService.registerUser({ fullname, email, password, phone, address });

    emailService.sendWelcomeEmail(user).catch((err) =>
      console.error('Failed to send welcome email:', err.message)
    );

    authService
      .createVerificationToken(user)
      .then((verificationToken) => {
        const verifyUrl = `${process.env.CLIENT_URL}/verify-email/${verificationToken}`;
        return emailService.sendVerificationEmail(user, verifyUrl);
      })
      .catch((err) => console.error('Failed to send verification email:', err.message));

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

    if (user) {
      const otp = await authService.createForgotPasswordOtp(user);
      emailService.sendForgotPasswordOtpEmail(user, otp).catch((err) =>
        console.error('Failed to send forgot-password OTP email:', err.message)
      );
    }

    res.json({
      success: true,
      message: 'If that email is registered, a verification code has been sent.',
    });
  } catch (error) {
    next(error);
  }
};

const verifyResetCode = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { email, otp } = req.body;
    await authService.verifyForgotPasswordOtp({ email, otp });
    res.json({ success: true, message: 'Code verified' });
  } catch (error) {
    // Wrong/expired code is the user's mistake, not a server fault —
    // 400 rather than falling through to the generic error handler.
    if (error.message === 'Invalid or expired code') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { email, otp, password } = req.body;
    const user = await authService.resetPassword({ email, otp, password });
    const authToken = generateToken({ id: user._id });
    res.json({ success: true, message: 'Password reset successful', data: { token: authToken } });
  } catch (error) {
    if (error.message === 'Invalid or expired code') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.params;
    const user = await authService.verifyEmail(token);
    const safeUser = user.toObject();
    delete safeUser.password;
    res.json({ success: true, message: 'Email verified successfully', data: { user: safeUser } });
  } catch (error) {
    next(error);
  }
};

const resendVerification = async (req, res, next) => {
  try {
    const { email } = req.body;
    const { user, verificationToken } = await authService.resendVerification(email);
    const verifyUrl = `${process.env.CLIENT_URL}/verify-email/${verificationToken}`;
    await emailService.sendVerificationEmail(user, verifyUrl);
    res.json({ success: true, message: 'Verification email resent' });
  } catch (error) {
    next(error);
  }
};

module.exports = { register, login, logout, forgotPassword, verifyResetCode, resetPassword, verifyEmail, resendVerification };