const express = require('express');
const coachPortalController = require('../controllers/coachPortalController');
const { protectCoach } = require('../middleware/coachAuthMiddleware');

const router = express.Router();

// Every route here is a coach viewing their own data — nothing
// admin-adjacent. Coach account management (create/edit/deactivate)
// lives separately in coachController.js, mounted under adminRoutes.js.
router.use(protectCoach);

router.get('/classes', coachPortalController.getMyClasses);
router.get('/classes/:id/members', coachPortalController.getMyClassRoster);

module.exports = router;