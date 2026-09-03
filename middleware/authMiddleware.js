const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  // 1) Authorization header: "Bearer <token>"
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  // 2) x-access-token header (convenience)
  if (!token && req.headers['x-access-token']) {
    token = req.headers['x-access-token'];
  }

  // 3) Cookie (app uses cookie-parser)
  if (!token && req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  // Deliberately no ?token=... query-string fallback here — query strings
  // end up in URLs, browser history, and server/proxy access logs, which
  // would leak the JWT. Nothing in this app relies on it (no window.open
  // links for CSV/PDF export etc.), so it's removed rather than fixed.

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, token missing' });
  }

  try {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ success: false, message: 'Not authorized, user not found' });
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account deactivated' });
    // Tokens issued before this field existed carry no tokenVersion —
    // treat that as 0 so already-logged-in users aren't kicked out the
    // moment this ships. From here on, every new token carries the
    // version it was minted with, and a logout/password-reset bumps
    // the DB value, which is what actually invalidates it.
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