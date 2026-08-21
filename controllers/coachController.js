const { validationResult } = require('express-validator');
const Coach = require('../models/Coach');
const escapeRegex = require('../utils/escapeRegex');
const { parsePagination } = require('../utils/paginate');

// All of these sit behind adminRoutes.js's router.use(protect, admin) —
// same as getMembers/createMember/etc. in adminController.js. Only an
// authenticated admin can reach any of this.

const getCoaches = async (req, res, next) => {
  try {
    const { page, limit, skip, isExport } = parsePagination(req.query);
    const { search, isActive } = req.query;

    const filter = {};
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

    const total = await Coach.countDocuments(filter);
    const coaches = await Coach.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit);

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
    const coach = await Coach.findById(req.params.id).select('-password');
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });
    res.json({ success: true, data: coach });
  } catch (error) {
    next(error);
  }
};

// The only way a coach account can be created — always by an authenticated
// admin, never by the coach themself. Closes the self-registration gap in
// the current CoachSignup.vue flow.
const createCoach = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { fullname, email, password, specialization } = req.body;

    const existing = await Coach.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A coach with this email already exists' });
    }

    const coach = await Coach.create({
      fullname,
      email: email.toLowerCase(),
      password,
      specialization,
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

    const coach = await Coach.findById(req.params.id);
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    const { fullname, specialization, email } = req.body;
    if (fullname) coach.fullname = fullname;
    if (specialization !== undefined) coach.specialization = specialization;

    if (email && email.toLowerCase() !== coach.email) {
      const existing = await Coach.findOne({ email: email.toLowerCase(), _id: { $ne: coach._id } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email is already in use by another coach' });
      }
      coach.email = email.toLowerCase();
    }

    await coach.save();
    res.json({ success: true, message: 'Coach updated', data: coach });
  } catch (error) {
    next(error);
  }
};

const setCoachStatus = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { isActive } = req.body;
    const coach = await Coach.findById(req.params.id);
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    coach.isActive = !!isActive;
    await coach.save();
    res.json({
      success: true,
      message: coach.isActive ? 'Coach activated' : 'Coach deactivated — this coach can no longer log in',
      data: coach,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getCoaches, getCoach, createCoach, updateCoach, setCoachStatus };