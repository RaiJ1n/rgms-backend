const { validationResult } = require('express-validator');
const User = require('../models/User');
const CoachQuestion = require('../models/CoachQuestion');
const CoachRegistrationRequest = require('../models/CoachRegistrationRequest');
const escapeRegex = require('../utils/escapeRegex');
const socketUtil = require('../utils/socket');

// Everything here sits behind coachDirectoryRoutes.js's router.use(protect, restrictTo('user'))

// Fields safe to show a Client/User browsing/viewing a coach
// Deliberately excludes password (handled by .select) and account-management fields
const PUBLIC_COACH_FIELDS =
  'fullname email phone address age sex occupation fitnessJourney currentFitnessGoal preferredExerciseTime photo specialization isDisplayed createdAt';

const getDisplayedCoaches = async (req, res, next) => {
  try {
    const { search } = req.query;
    const filter = { role: 'coach', isDisplayed: true };
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ fullname: re }, { occupation: re }, { currentFitnessGoal: re }, { specialization: re }];
    }

    const coaches = await User.find(filter).select(PUBLIC_COACH_FIELDS).sort({ fullname: 1 });
    res.json({ success: true, data: coaches });
  } catch (error) {
    next(error);
  }
};

const getDisplayedCoach = async (req, res, next) => {
  try {
    const coach = await User.findOne({ _id: req.params.id, role: 'coach', isDisplayed: true }).select(
      PUBLIC_COACH_FIELDS
    );
    // Deliberately the same 404 whether the id doesn't exist, belongs to a non-coach account
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found or not currently available' });
    res.json({ success: true, data: coach });
  } catch (error) {
    next(error);
  }
};

// Active questionnaire, in admin-configured order
const getActiveQuestions = async (req, res, next) => {
  try {
    const questions = await CoachQuestion.find({ isActive: true })
      .select('question type options order')
      .sort({ order: 1, createdAt: 1 });
    res.json({ success: true, data: questions });
  } catch (error) {
    next(error);
  }
};

const registerToCoach = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    // This submission goes to a COACH, not just gym staff
    if (!req.user.privacyNoticeAcknowledged) {
      if (!req.body.privacyNoticeAcknowledged) {
        return res.status(400).json({
          success: false,
          message: 'Please acknowledge the Privacy Notice before submitting your registration.',
        });
      }
      req.user.privacyNoticeAcknowledged = true;
      req.user.privacyNoticeAcknowledgedAt = new Date();
      await req.user.save();
    }

    const coach = await User.findOne({ _id: req.params.id, role: 'coach', isDisplayed: true });
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found or not currently available' });

    // Business rule
    const existing = await CoachRegistrationRequest.findOne({
      clientId: req.user._id,
      status: { $in: ['pending', 'accepted'] },
    });
    if (existing) {
      const sameCoach = existing.coachId.toString() === coach._id.toString();
      return res.status(409).json({
        success: false,
        message:
          existing.status === 'accepted'
            ? sameCoach
              ? 'You are already registered with this coach'
              : 'You are already registered with a coach. You can only be registered with one coach at a time.'
            : sameCoach
              ? 'You already have a pending registration request with this coach'
              : 'You already have a pending registration request with another coach. Please wait for their response before registering elsewhere.',
      });
    }

    const activeQuestions = await CoachQuestion.find({ isActive: true });
    const submitted = Array.isArray(req.body.answers) ? req.body.answers : [];
    const byId = new Map(submitted.map((a) => [String(a.questionId), a.answer]));

    const answers = [];
    for (const q of activeQuestions) {
      const raw = byId.get(String(q._id));
      const isEmpty =
        raw === undefined ||
        raw === null ||
        (typeof raw === 'string' && raw.trim() === '') ||
        (Array.isArray(raw) && raw.length === 0);
      if (isEmpty) {
        return res.status(400).json({ success: false, message: `Please answer: "${q.question}"` });
      }
      answers.push({ questionId: q._id, question: q.question, answer: raw });
    }

    let request;
    try {
      request = await CoachRegistrationRequest.create({
        clientId: req.user._id,
        coachId: coach._id,
        answers,
        status: 'pending',
      });
    } catch (createError) {
      // The findOne check above is read-then-write and has a race window between two concurrent registration
      // The findOne check above is read-then-write and has a race window between two concurrent registration submissions
      if (createError?.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'You already have an active registration request or coach. You can only be registered with one coach at a time.',
        });
      }
      throw createError;
    }

    // Best-effort real-time nudge to the coach — see utils/socket.js's emitToUser
    socketUtil.emitToUser(coach._id, 'coach-request:new', {
      requestId: request._id,
      clientName: req.user.fullname,
    });

    res.status(201).json({ success: true, message: 'Registration request submitted', data: request });
  } catch (error) {
    next(error);
  }
};

// Every request this client has ever made, newest first — powers MyCoach.vue's status view
const getMyRequests = async (req, res, next) => {
  try {
    const requests = await CoachRegistrationRequest.find({ clientId: req.user._id })
      .populate('coachId', 'fullname email photo occupation specialization')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
};

module.exports = { getDisplayedCoaches, getDisplayedCoach, getActiveQuestions, registerToCoach, getMyRequests };