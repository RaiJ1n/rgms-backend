const express = require('express');
const { body } = require('express-validator');
const coachDirectoryController = require('../controllers/coachDirectoryController');
const { protect } = require('../middleware/authMiddleware');
const { restrictTo } = require('../middleware/roleMiddleware');

const router = express.Router();

// Mounted at /api/coaches (plural) in app.js — deliberately NOT under
// /api/coach, which is already reserved for coachRoutes.js's coach-self
// portal (protectCoach). See lib/api.js on the frontend for the related
// fix to isCoachRequest's prefix check, which used to treat any
// '/coaches...' URL as a coach-authenticated request.
//
// Every route here is a Client/User browsing coaches and registering —
// restrictTo('user') matches the spec's role table (Section 13: only
// Client/User can view displayed coaches / register).
router.use(protect, restrictTo('user'));

// NOTE: '/questions' and '/my-requests' must be declared before '/:id'
// so Express doesn't try to treat either literal segment as a coach id.
router.get('/questions', coachDirectoryController.getActiveQuestions);
router.get('/my-requests', coachDirectoryController.getMyRequests);

router.get('/', coachDirectoryController.getDisplayedCoaches);
router.get('/:id', coachDirectoryController.getDisplayedCoach);
router.post(
  '/:id/register',
  [body('answers').optional().isArray().withMessage('Answers must be a list')],
  coachDirectoryController.registerToCoach
);

module.exports = router;
