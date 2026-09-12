const { validationResult } = require('express-validator');
const User = require('../models/User');
const CoachQuestion = require('../models/CoachQuestion');
const CoachRegistrationRequest = require('../models/CoachRegistrationRequest');
const escapeRegex = require('../utils/escapeRegex');
const socketUtil = require('../utils/socket');

// Everything here sits behind coachDirectoryRoutes.js's
// router.use(protect, restrictTo('user')) — a logged-in Client/User
// browsing/registering to a Coach. Mirrors how coachController.js scopes
// every query to { role: 'coach' } and coachPortalController.js scopes
// every query to req.coach._id — here every coach-facing query is
// additionally scoped to isDisplayed: true (Section 9/15: "Hidden
// Coaches must not appear on the Client Coaches page", "Clients can
// only register to displayed Coaches").

// Fields safe to show a Client/User browsing/viewing a coach. Deliberately
// excludes password (handled by .select) and account-management fields
// (isActive, createdBy) that are none of a client's business.
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
    // Deliberately the same 404 whether the id doesn't exist, belongs to
    // a non-coach account, or belongs to a coach the admin has hidden —
    // a client should never be able to distinguish "no such coach" from
    // "that coach exists but is hidden" by probing ids.
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found or not currently available' });
    res.json({ success: true, data: coach });
  } catch (error) {
    next(error);
  }
};

// Active questionnaire, in admin-configured order — pulled in by the
// Coach Registration Questionnaire page before the client answers.
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

    // Section D1: this submission goes to a COACH, not just gym staff —
    // CoachQuestion.js's own comment gives "Do you have any allergies?"
    // as an example question, so this route can carry health info to a
    // third party. req.user is already the full document authMiddleware
    // fetched for this request (minus password), so it can be saved
    // directly — no extra query needed.
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

    // Business rule: a client may only be registered with (or have a
    // pending request to) ONE coach at a time — across ALL coaches, not
    // just this one. This used to be scoped with `coachId: coach._id`,
    // which only blocked a duplicate request to the SAME coach and let
    // a client freely register with a second, different coach while
    // already pending/accepted elsewhere. A client with only rejected
    // history (with this coach or any other) can still submit a fresh
    // request — only an active (pending) or already-successful
    // (accepted) request, with any coach, blocks a new submission.
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

    // Validate the submitted answers against the currently active
    // question set — Section 17: "Required questionnaire question is
    // unanswered." A question added/edited after the client loaded the
    // form is still enforced correctly since this re-reads it fresh
    // server-side rather than trusting whatever the client posts.
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
      // The findOne check above is read-then-write and has a race
      // window between two concurrent registration submissions from the
      // same client (e.g. double-clicking Submit, or two tabs). The
      // partial unique index on { clientId } (see CoachRegistrationRequest.js)
      // is the actual guarantee — E11000 here means that race was hit,
      // so surface the same friendly message instead of a raw 500.
      if (createError?.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'You already have an active registration request or coach. You can only be registered with one coach at a time.',
        });
      }
      throw createError;
    }

    // Best-effort real-time nudge to the coach — see utils/socket.js's
    // emitToUser, joined by every authenticated socket regardless of
    // role, same mechanism already used for member->admin notifications
    // in studentIdController.js.
    socketUtil.emitToUser(coach._id, 'coach-request:new', {
      requestId: request._id,
      clientName: req.user.fullname,
    });

    res.status(201).json({ success: true, message: 'Registration request submitted', data: request });
  } catch (error) {
    next(error);
  }
};

// Every request this client has ever made, newest first — powers
// MyCoach.vue's status view ("Pending" / "Accepted" / "Rejected") and
// lets the frontend show which coach(es) they're already
// pending/registered with when browsing the Coaches list.
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