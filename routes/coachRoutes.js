const express = require('express');
const { body } = require('express-validator');
const coachPortalController = require('../controllers/coachPortalController');
const exerciseController = require('../controllers/exerciseController');
const workoutPlanController = require('../controllers/workoutPlanController');
const { protectCoach } = require('../middleware/coachAuthMiddleware');
const upload = require('../middleware/uploadMiddleware');
const { MUSCLE_GROUPS } = require('../utils/muscleGroups');

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

// Settings (Section 1) — notification email + password, separate from
// Personal Information above.
router.get('/settings', coachPortalController.getMySettings);
router.put(
  '/settings',
  [
    body('notificationEmail')
      .optional({ checkFalsy: true })
      .isEmail()
      .withMessage('Enter a valid notification email'),
  ],
  coachPortalController.updateMySettings
);
router.put(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    body('confirmPassword').custom((value, { req }) => value === req.body.newPassword).withMessage('Passwords do not match'),
  ],
  coachPortalController.changeMyPassword
);

// Client requests / client management (Sections 6/7)
router.get('/requests', coachPortalController.getMyRequests);
router.put('/requests/:id/accept', coachPortalController.acceptRequest);
router.put('/requests/:id/reject', coachPortalController.rejectRequest);
router.get('/clients', coachPortalController.getMyClients);

// ---- Exercise library (Section E3) — private per-coach ----
router.get('/exercises', exerciseController.getMyExercises);
router.post(
  '/exercises',
  [
    body('name').notEmpty().withMessage('Exercise name is required'),
    body('category').isIn(['Strength', 'Cardio', 'Flexibility', 'Balance', 'HIIT']).withMessage('Invalid category'),
    body('description').optional().isString().trim(),
    body('muscleGroups').optional().isArray().withMessage('muscleGroups must be a list'),
    body('muscleGroups.*').optional().isIn(MUSCLE_GROUPS).withMessage('Invalid muscle group'),
    body('defaultSets').isInt({ min: 1 }).withMessage('Sets must be a positive number'),
    body('defaultReps').isInt({ min: 1 }).withMessage('Reps must be a positive number'),
  ],
  exerciseController.createExercise
);
router.put(
  '/exercises/:id',
  [
    body('name').optional().notEmpty(),
    body('category').optional().isIn(['Strength', 'Cardio', 'Flexibility', 'Balance', 'HIIT']),
    body('description').optional().isString().trim(),
    body('muscleGroups').optional().isArray(),
    body('muscleGroups.*').optional().isIn(MUSCLE_GROUPS),
    body('defaultSets').optional().isInt({ min: 1 }),
    body('defaultReps').optional().isInt({ min: 1 }),
  ],
  exerciseController.updateExercise
);
router.delete('/exercises/:id', exerciseController.deleteExercise);

// ---- Workout plans (Sections E4/E5) ----
router.get('/workout-plans', workoutPlanController.getMyPlans);
router.post(
  '/workout-plans',
  [
    body('name').notEmpty().withMessage('Plan name is required'),
    body('type').isIn(['Strength', 'Cardio', 'Flexibility', 'HIIT', 'Mixed']).withMessage('Invalid type'),
    body('duration').notEmpty().withMessage('Duration is required'),
    body('description').optional().isString().trim(),
    body('components').optional().isArray(),
    // Section E4: this only validates SHAPE (real Mongo ids). Whether
    // each id is actually one of this coach's own accepted clients is
    // enforced in workoutPlanController.assertAssignedToEligible, not
    // here — that check needs a DB query the validator layer can't do.
    body('assignedTo').optional().isArray(),
    body('assignedTo.*').optional().isMongoId().withMessage('Invalid client selected'),
  ],
  workoutPlanController.createPlan
);
router.put(
  '/workout-plans/:id',
  [
    body('name').optional().notEmpty(),
    body('type').optional().isIn(['Strength', 'Cardio', 'Flexibility', 'HIIT', 'Mixed']),
    body('duration').optional().notEmpty(),
    body('description').optional().isString().trim(),
    body('components').optional().isArray(),
    body('assignedTo').optional().isArray(),
    body('assignedTo.*').optional().isMongoId().withMessage('Invalid client selected'),
  ],
  workoutPlanController.updatePlan
);
router.delete('/workout-plans/:id', workoutPlanController.deletePlan);

module.exports = router;