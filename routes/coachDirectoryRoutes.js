const express = require('express');
const { body } = require('express-validator');
const coachDirectoryController = require('../controllers/coachDirectoryController');
const { protect } = require('../middleware/authMiddleware');
const { restrictTo } = require('../middleware/roleMIddleware');

const router = express.Router();

// Mounted at /api/coaches (plural) in app.js — deliberately NOT under /api/coach
// See lib/api.js on the frontend for the related fix to isCoachRequest's prefix check, which
router.use(protect, restrictTo('user'));

// NOTE
router.get('/questions', coachDirectoryController.getActiveQuestions);
router.get('/my-requests', coachDirectoryController.getMyRequests);

router.get('/', coachDirectoryController.getDisplayedCoaches);
router.get('/:id', coachDirectoryController.getDisplayedCoach);
router.post(
  '/:id/register',
  [
    body('answers').optional().isArray().withMessage('Answers must be a list'),
    body('privacyNoticeAcknowledged').optional().isBoolean(),
  ],
  coachDirectoryController.registerToCoach
);

module.exports = router;