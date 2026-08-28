const express = require('express');
const { body } = require('express-validator');
const coachPortalController = require('../controllers/coachPortalController');
const { protectCoach } = require('../middleware/coachAuthMiddleware');
const upload = require('../middleware/uploadMiddleware');

const router = express.Router();

// Every route here is a coach viewing/managing their own data — nothing
// admin-adjacent. Coach account management (create/edit/deactivate)
// lives separately in coachController.js, mounted under adminRoutes.js.
router.use(protectCoach);

router.get('/classes', coachPortalController.getMyClasses);
router.get('/classes/:id/members', coachPortalController.getMyClassRoster);

// Personal Information (Section 5)
router.get('/profile', coachPortalController.getMyProfile);
router.put(
  '/profile',
  [
    body('fullname').optional().notEmpty().withMessage('Full name is required'),
    body('age').optional({ nullable: true }).isInt({ min: 0, max: 120 }).withMessage('Enter a valid age'),
    body('sex').optional({ checkFalsy: true }).isIn(['Male', 'Female', 'Other']).withMessage('Invalid sex value'),
    body('phone').optional().isString().trim(),
    body('address').optional().isString().trim(),
    body('occupation').optional().isString().trim(),
    body('fitnessJourney').optional().isString().trim(),
    body('currentFitnessGoal').optional().isString().trim(),
    body('preferredExerciseTime').optional().isString().trim(),
  ],
  coachPortalController.updateMyProfile
);
router.put('/profile/photo', upload.single('photo'), coachPortalController.uploadMyProfilePhoto);

// Client requests / client management (Sections 6/7)
router.get('/requests', coachPortalController.getMyRequests);
router.put('/requests/:id/accept', coachPortalController.acceptRequest);
router.put('/requests/:id/reject', coachPortalController.rejectRequest);
router.get('/clients', coachPortalController.getMyClients);

module.exports = router;