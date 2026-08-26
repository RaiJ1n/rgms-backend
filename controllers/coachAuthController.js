// DEPRECATED: coach login/logout now go through the single unified
// authController.login / authController.logout (POST /api/auth/login,
// POST /api/auth/logout). Those already authenticate against the User
// collection, which is where coach accounts (role: 'coach') actually
// live — this controller's own login handler queried the exact same
// collection, just from a second code path that had to be kept in sync
// by hand. coachAuthRoutes.js no longer wires this file up; it's kept
// only so nothing breaks if another file still requires it, and can be
// deleted outright once you've confirmed nothing does.
module.exports = {};
