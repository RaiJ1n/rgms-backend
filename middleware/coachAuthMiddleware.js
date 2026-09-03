const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protectCoach = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token && req.headers['x-access-token']) {
    token = req.headers['x-access-token'];
  }

  if (!token && req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const coach = await User.findById(decoded.id).select('-password');

    // Reject even if the id resolves to a real user — a member or
    // admin token must never grant access to coach-only routes just
    // because the id happens to be valid.
    if (!coach || coach.role !== 'coach') {
      return res.status(401).json({ success: false, message: 'Not authorized, coach not found' });
    }

    if (!coach.isActive) {
      return res.status(403).json({ success: false, message: 'Coach account deactivated' });
    }

    if ((decoded.tokenVersion || 0) !== (coach.tokenVersion || 0)) {
      return res.status(401).json({ success: false, message: 'Session expired, please log in again' });
    }

    req.coach = coach;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
  }
};

module.exports = { protectCoach };