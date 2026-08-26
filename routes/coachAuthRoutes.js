const express = require('express');

const router = express.Router();

// Coach login/logout were removed from here — coaches now authenticate
// through the single unified endpoint, POST /api/auth/login
// (authController.login), same as Admin and User/Member. That endpoint
// already looks the account up in the User collection (coaches are
// role: 'coach' rows there, not a separate table used for auth) and
// returns the account's real role, so the frontend can route to the
// Coach Dashboard without a coach-specific login endpoint to maintain.
//
// Nothing else in this file needs protectCoach — token-protected coach
// portal routes (fetching clients, workout plans, etc.) live in
// coachRoutes.js and are unaffected by this change: a token minted by
// the unified /auth/login is a normal signed JWT containing { id },
// exactly like the one this endpoint used to issue, so it still passes
// coachAuthMiddleware.protectCoach's lookup-and-role-check unchanged.

module.exports = router;