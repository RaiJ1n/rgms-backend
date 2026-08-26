// Generic role guard to use alongside authMiddleware.protect.
//
// Usage in a routes file:
//   const { protect } = require('../middleware/authMiddleware');
//   const { restrictTo } = require('../middleware/roleMiddleware');
//   router.get('/admin/something', protect, restrictTo('admin'), handler);
//
// protect() already fetches the full User document by the id encoded in
// the JWT and attaches it as req.user — including req.user.role. This
// middleware only ever reads that DB-sourced role; it never looks at
// anything the client sent in the request body, headers, or query
// string, so a member can't grant themselves admin/coach access by
// asserting a role — the role has to actually be set on their User row.
//
// This is a drop-in replacement for the older single-purpose guards
// (middleware/adminMiddleware.js's `admin`, middleware/
// coachAuthMiddleware.js's `protectCoach`) which each hard-coded one
// role. Those still work fine with tokens issued by the new unified
// POST /api/auth/login (it's the same JWT shape, { id }, they always
// expected) — you don't have to migrate every route today. Prefer
// restrictTo() for any new role-protected route going forward so there's
// one place role-checking logic lives instead of one per role.
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
