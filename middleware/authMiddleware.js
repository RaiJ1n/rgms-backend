const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token && req.headers['x-access-token']) {
    token = req.headers['x-access-token'];
  }

  // 3) Cookie (app uses cookie-parser)
  if (!token && req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  // Deliberately no ?token=... query-string fallback here — query strings end up in URLs
  // Deliberately no ?token=... query-string fallback here — query strings end up in URLs, browser history

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, token missing' });
  }

  try {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ success: false, message: 'Not authorized, user not found' });
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account deactivated' });
    // Tokens issued before this field existed carry no tokenVersion — treat that as 0
    if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ success: false, message: 'Session expired, please log in again' });
    }
    req.user = user;
    next();
    } catch (error) {
      return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
    }
};

module.exports = { protect };