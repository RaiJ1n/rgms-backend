const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Guards POST /api/admin/auth/register.
//
// - No admin account exists yet -> request passes through untouched
//   (one-time bootstrap so the very first admin can be created).
// - At least one admin already exists -> the requester must present a
//   valid JWT for an existing admin. Anonymous registration is refused.
//
// This replaces the old shared ADMIN_REGISTRATION_KEY, which was a single
// static secret with no way to revoke access to one person without
// rotating it for everyone.
const requireAdminIfExists = async (req, res, next) => {
  try {
    const adminCount = await User.countDocuments({ role: 'admin' });
    if (adminCount === 0) {
      return next();
    }

    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(403).json({
        success: false,
        message: 'An admin account already exists. Log in as an admin to create another.',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const requester = await User.findById(decoded.id).select('-password');

    if (!requester || requester.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only an existing admin can create another admin account.',
      });
    }

    req.user = requester;
    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      message: 'Only an existing admin can create another admin account.',
    });
  }
};

module.exports = { requireAdminIfExists };