const express = require('express');
const coachAuthController = require('../controllers/coachAuthController');

const router = express.Router();

// Deliberately NOT behind protectCoach — this is where a coach token
// is issued in the first place. Portal routes that need an existing
// token live in coachRoutes.js.
router.post('/login', coachAuthController.login);
router.post('/logout', coachAuthController.logout);

module.exports = router;