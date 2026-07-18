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

  // 4) Query string: ?token=...
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
  }
};

module.exports = { protect };
