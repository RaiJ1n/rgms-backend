// Generic role guard to use alongside authMiddleware.protect
const restrictTo = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authorized, no user on request' });
  }
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Access denied for this account type' });
  }
  next();
};

module.exports = { restrictTo };
