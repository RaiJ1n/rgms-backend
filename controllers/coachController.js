const { validationResult } = require('express-validator');
const User = require('../models/User');
const escapeRegex = require('../utils/escapeRegex');
const { parsePagination } = require('../utils/paginate');

// All of these sit behind adminRoutes.js's router.use(protect, admin) —
// same as getMembers/createMember/etc. in adminController.js. Only an
// authenticated admin can reach any of this.
//
// Coaches are User documents with role: 'coach' — NOT a separate
// collection. This used to be a standalone `Coach` model/collection,
// which is why admin-created coaches could never log in: the unified
// POST /auth/login only ever queries the User collection
// (authService.loginUser -> User.findOne({ email })), so an account
// living anywhere else was invisible to login no matter how correct
// the credentials were. Every query below is scoped with
// { role: 'coach' } (mirroring how adminController.js scopes member
// queries with { role: 'user' }) so these endpoints can only ever see
// or touch coach accounts, never admins or members.

const getCoaches = async (req, res, next) => {
  try {
    const { page, limit, skip, isExport } = parsePagination(req.query);
    const { search, isActive } = req.query;

    const filter = { role: 'coach' };
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ fullname: re }, { email: re }, { specialization: re }];
    }
    // Used by AdminClasses.vue's instructor dropdown (?isActive=true) so
    // a deactivated coach — who can no longer log in — can't be newly
    // assigned to a class. The main coach-management table calls this
    // without the param and still sees everyone, active or not.
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    const total = await User.countDocuments(filter);
    const coaches = await User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit);

    res.json({
      success: true,
      data: coaches,
      page,
      limit,
      total,
      totalPages: isExport ? 1 : Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

const getCoach = async (req, res, next) => {
  try {
    const coach = await User.findOne({ _id: req.params.id, role: 'coach' }).select('-password');
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });
    res.json({ success: true, data: coach });
  } catch (error) {
    next(error);
  }
};

// The only way a coach account can be created — always by an authenticated
// admin, never by the coach themself. Closes the self-registration gap in
// the current CoachSignup.vue flow.
//
// Creates a normal User document with role: 'coach' (same shape/hook
// chain as adminController.createMember's role: 'user'), so the account
// this endpoint creates is the exact same kind of record the unified
// POST /auth/login already knows how to authenticate — no separate
// login path, no separate collection, nothing coach-specific to keep
// in sync by hand.
const createCoach = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { fullname, email, password, specialization } = req.body;

    // Email is unique across the whole User collection (admins, members,
    // and coaches all share it), so this check also catches a coach
    // email colliding with an existing member/admin account — which is
    // correct: it's the same login table now.
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists' });
    }

    const coach = await User.create({
      fullname,
      email: email.toLowerCase(),
      password,
      specialization,
      role: 'coach',
      isVerified: true, // admin-created, same as createMember — no self-serve verification step
      createdBy: req.user._id,
    });

    const safeCoach = coach.toObject();
    delete safeCoach.password;

    res.status(201).json({ success: true, message: 'Coach account created', data: safeCoach });
  } catch (error) {
    next(error);
  }
};

const updateCoach = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const coach = await User.findOne({ _id: req.params.id, role: 'coach' });
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    const { fullname, specialization, email } = req.body;
    if (fullname) coach.fullname = fullname;
    if (specialization !== undefined) coach.specialization = specialization;

    if (email && email.toLowerCase() !== coach.email) {
      const existing = await User.findOne({ email: email.toLowerCase(), _id: { $ne: coach._id } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email is already in use by another account' });
      }
      coach.email = email.toLowerCase();
    }

    await coach.save();
    const safeCoach = coach.toObject();
    delete safeCoach.password;
    res.json({ success: true, message: 'Coach updated', data: safeCoach });
  } catch (error) {
    next(error);
  }
};

const setCoachStatus = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { isActive } = req.body;
    const coach = await User.findOne({ _id: req.params.id, role: 'coach' });
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    coach.isActive = !!isActive;
    await coach.save();
    const safeCoach = coach.toObject();
    delete safeCoach.password;
    res.json({
      success: true,
      message: coach.isActive ? 'Coach activated' : 'Coach deactivated — this coach can no longer log in',
      data: safeCoach,
    });
  } catch (error) {
    next(error);
  }
};

// Admin-only control over whether a coach is publicly displayed on the
// Client/User "Coaches" page (Section 9). Distinct from setCoachStatus
// above — isActive controls whether the coach can log in at all,
// isDisplayed only controls public visibility. Hiding a coach here must
// NOT touch isActive, existing CoachRegistrationRequest documents, or
// any already-accepted client relationship — see the model comments on
// CoachRegistrationRequest for why accepted relationships are untouched
// by this toggle.
const setCoachVisibility = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { isDisplayed } = req.body;
    const coach = await User.findOne({ _id: req.params.id, role: 'coach' });
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    coach.isDisplayed = !!isDisplayed;
    await coach.save();
    const safeCoach = coach.toObject();
    delete safeCoach.password;
    res.json({
      success: true,
      message: coach.isDisplayed
        ? 'Coach is now visible to clients'
        : 'Coach is now hidden from clients',
      data: safeCoach,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getCoaches, getCoach, createCoach, updateCoach, setCoachStatus, setCoachVisibility };