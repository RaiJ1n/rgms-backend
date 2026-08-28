const { validationResult } = require('express-validator');
const GymClass = require('../models/GymClass');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const cloudinary = require('../config/cloudinary');
const socketUtil = require('../utils/socket');
const escapeRegex = require('../utils/escapeRegex');
const { parsePagination } = require('../utils/paginate');

function deleteCloudinaryImage(publicId) {
  if (!publicId) return;
  cloudinary.uploader.destroy(publicId).catch((err) => {
    console.error('Failed to delete old class image from Cloudinary:', err.message);
  });
}

const INSTRUCTOR_POPULATE = { path: 'instructorId', select: 'fullname specialization' };

function getClassEndDateTime(gymClass) {
  const end = new Date(gymClass.date);
  const [hours, minutes] = (gymClass.endTime || '00:00').split(':').map(Number);
  end.setHours(hours || 0, minutes || 0, 0, 0);
  return end;
}

async function syncCompletedClasses() {
  const now = new Date();
  const activeClasses = await GymClass.find({ status: 'Active' }).select('date endTime');
  const idsToComplete = activeClasses
    .filter((c) => getClassEndDateTime(c) < now)
    .map((c) => c._id);
  if (idsToComplete.length) {
    await GymClass.updateMany({ _id: { $in: idsToComplete } }, { $set: { status: 'Completed' } });
  }
}

const ALLOWED_FIELDS = ['name', 'description', 'instructorId', 'date', 'startTime', 'endTime', 'status', 'capacity'];

function pickPayload(body) {
  const payload = {};
  for (const key of ALLOWED_FIELDS) {
    if (body[key] === '' && key === 'instructorId') {
      payload.instructorId = undefined;
      continue;
    }
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

async function assertValidInstructor(instructorId) {
  if (!instructorId) return; // unassigning is always fine
  const coach = await User.findOne({ _id: instructorId, role: 'coach' }).select('isActive');
  if (!coach) {
    throw Object.assign(new Error('Selected instructor was not found'), { statusCode: 404 });
  }
  if (!coach.isActive) {
    throw Object.assign(new Error('Selected instructor is not an active coach'), { statusCode: 400 });
  }
}

exports.createClass = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const payload = pickPayload(req.body);
    await assertValidInstructor(payload.instructorId);
    if (req.file) payload.image = { url: req.file.path, public_id: req.file.filename };
    let gymClass = new GymClass(payload);
    await gymClass.save();
    gymClass = await gymClass.populate(INSTRUCTOR_POPULATE);
    socketUtil.emitToAll('class:list-changed');
    res.status(201).json({ gymClass });
  } catch (err) { next(err); }
};

exports.getClasses = async (req, res, next) => {
  try {
    await syncCompletedClasses();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const classes = await GymClass.find({ status: 'Active', date: { $gte: startOfToday } })
      .populate(INSTRUCTOR_POPULATE)
      .sort({ date: 1, startTime: 1 });
    res.json({ data: classes });
  } catch (err) { next(err); }
};

exports.getAllClassesAdmin = async (req, res, next) => {
  try {
    await syncCompletedClasses();

    const { page, limit, skip, isExport } = parsePagination(req.query);
    const { search } = req.query;

    const filter = {};
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      const matchingCoachIds = await User.find({ fullname: re, role: 'coach' }).distinct('_id');
      filter.$or = [{ name: re }, { instructorId: { $in: matchingCoachIds } }];
    }

    const total = await GymClass.countDocuments(filter);
    const classes = await GymClass.find(filter)
      .populate(INSTRUCTOR_POPULATE)
      .sort({ date: -1, startTime: 1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: classes,
      page,
      limit,
      total,
      totalPages: isExport ? 1 : Math.ceil(total / limit),
    });
  } catch (err) { next(err); }
};

exports.getClass = async (req, res, next) => {
  try {
    await syncCompletedClasses();
    const gymClass = await GymClass.findById(req.params.id).populate(INSTRUCTOR_POPULATE);
    if (!gymClass) return res.status(404).json({ message: 'Not found' });
    res.json({ data: gymClass });
  } catch (err) { next(err); }
};

exports.getClassMembers = async (req, res, next) => {
  try {
    await syncCompletedClasses();
    const gymClass = await GymClass.findById(req.params.id)
      .populate('attendees', 'fullname email phone')
      .populate(INSTRUCTOR_POPULATE);
    if (!gymClass) return res.status(404).json({ message: 'Class not found' });

    const members = gymClass.attendees.map((u) => ({
      _id: u._id,
      name: u.fullname,
      email: u.email,
      phone: u.phone,
    }));

    res.json({
      data: {
        class: {
          _id: gymClass._id,
          name: gymClass.name,
          instructorId: gymClass.instructorId,
          date: gymClass.date,
          startTime: gymClass.startTime,
          endTime: gymClass.endTime,
          status: gymClass.status,
          capacity: gymClass.capacity,
        },
        members,
      },
    });
  } catch (err) { next(err); }
};

exports.updateClass = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const payload = pickPayload(req.body);
    await assertValidInstructor(payload.instructorId);

    let oldPublicId = null;
    if (req.file) {
      const existing = await GymClass.findById(req.params.id).select('image');
      if (!existing) return res.status(404).json({ message: 'Not found' });
      oldPublicId = existing.image?.public_id;
      payload.image = { url: req.file.path, public_id: req.file.filename };
    }

    const updated = await GymClass.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true })
      .populate(INSTRUCTOR_POPULATE);
    if (!updated) return res.status(404).json({ message: 'Not found' });

    deleteCloudinaryImage(oldPublicId);

    socketUtil.emitToAll('class:list-changed');
    res.json({ data: updated });
  } catch (err) { next(err); }
};

exports.deleteClass = async (req, res, next) => {
  try {
    const deleted = await GymClass.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Not found' });
    deleteCloudinaryImage(deleted.image?.public_id);
    socketUtil.emitToAll('class:list-changed');
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
};

exports.registerMember = async (req, res, next) => {
  try {
    const memberId = req.user._id;
    const gymClass = await GymClass.findById(req.params.id);
    if (!gymClass) return res.status(404).json({ message: 'Class not found' });
    if (gymClass.status !== 'Active') return res.status(400).json({ message: 'This class is not open for registration' });
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (gymClass.date < startOfToday) return res.status(400).json({ message: 'This class has already taken place' });

    if (getClassEndDateTime(gymClass) <= new Date()) {
      return res.status(400).json({ message: 'This class has already taken place' });
    }
    if (gymClass.attendees.includes(memberId)) return res.status(400).json({ message: 'Already registered' });
    const updated = await GymClass.findOneAndUpdate(
      {
        _id: req.params.id,
        status: 'Active',
        date: { $gte: startOfToday },
        attendees: { $ne: memberId },
        $expr: { $lt: [{ $size: '$attendees' }, '$capacity'] },
      },
      { $push: { attendees: memberId } },
      { new: true }
    ).populate(INSTRUCTOR_POPULATE);
if (!updated) return res.status(400).json({ message: 'Unable to register (full, already registered, or closed)' });
    await AuditLog.create({ action: 'class_register', userId: memberId, meta: { classId: gymClass._id } });

    socketUtil.emitToAll('class:updated', updated);
    res.json({ message: 'Registered', gymClass: updated });
  } catch (err) { next(err); }
};

exports.cancelRegistration = async (req, res, next) => {
  try {
    const memberId = req.user._id;
    const gymClass = await GymClass.findById(req.params.id);
    if (!gymClass) return res.status(404).json({ message: 'Class not found' });
    gymClass.attendees = gymClass.attendees.filter(a => a.toString() !== memberId.toString());
    await gymClass.save();
    await gymClass.populate(INSTRUCTOR_POPULATE);
    await AuditLog.create({ action: 'class_cancel', userId: memberId, meta: { classId: gymClass._id } });
    socketUtil.emitToAll('class:updated', gymClass);
    res.json({ message: 'Cancelled', gymClass });
  } catch (err) { next(err); }
};