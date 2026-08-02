const { validationResult } = require('express-validator');
const GymClass = require('../models/GymClass');
const AuditLog = require('../models/AuditLog');
const cloudinary = require('../config/cloudinary');
const socketUtil = require('../utils/socket');

// Fire-and-forget Cloudinary cleanup — used when a class image is
// replaced or the class itself is deleted, so old uploads don't pile up
// in the 'rgms' folder forever. Mirrors the fire-and-forget notification
// pattern already used elsewhere (e.g. studentIdController).
function deleteCloudinaryImage(publicId) {
  if (!publicId) return;
  cloudinary.uploader.destroy(publicId).catch((err) => {
    console.error('Failed to delete old class image from Cloudinary:', err.message);
  });
}

// Fields an admin can set from the create/edit form. Kept in one list so
// createClass/updateClass can't drift apart, and so findByIdAndUpdate
// only ever touches fields we actually meant to expose (not attendees,
// not image — image is handled separately below from req.file).
const ALLOWED_FIELDS = ['name', 'description', 'instructor', 'date', 'startTime', 'endTime', 'status', 'capacity', 'fee'];

function pickPayload(body) {
  const payload = {};
  for (const key of ALLOWED_FIELDS) {
    // Previously also skipped '' , which meant clearing an optional field
    // (e.g. wiping out Description or Instructor in the edit form) had no
    // effect — the old value stayed in the database with no error shown.
    // Required fields (name/date/startTime/endTime) can't reach here as ''
    // anyway: express-validator's notEmpty() rules on the route reject
    // that before the controller runs.
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

exports.createClass = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const payload = pickPayload(req.body);
    if (req.file) payload.image = { url: req.file.path, public_id: req.file.filename };
    const gymClass = new GymClass(payload);
    await gymClass.save();
    // A brand-new class won't exist yet in anyone else's already-loaded
    // list, so this is a "go refetch" signal rather than a patchable doc —
    // same reasoning as 'stats:refresh' elsewhere.
    socketUtil.emitToAll('class:list-changed');
    res.status(201).json({ gymClass });
  } catch (err) { next(err); }
};

// Public/member-facing list (Classes.vue). Only classes that are still
// open: 'Active' status and the date hasn't passed. A class the admin
// marks Cancelled/Completed, or whose date has simply gone by, drops off
// this list automatically — no separate cleanup job needed.
exports.getClasses = async (req, res, next) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const classes = await GymClass.find({ status: 'Active', date: { $gte: startOfToday } })
      .sort({ date: 1, startTime: 1 });
    res.json({ data: classes });
  } catch (err) { next(err); }
};

// Admin-facing list (AdminClasses.vue) — everything, regardless of
// status or date, so the admin can see past/cancelled classes too.
exports.getAllClassesAdmin = async (req, res, next) => {
  try {
    const classes = await GymClass.find().sort({ date: -1, startTime: 1 });
    res.json({ data: classes });
  } catch (err) { next(err); }
};

exports.getClass = async (req, res, next) => {
  try {
    const gymClass = await GymClass.findById(req.params.id);
    if (!gymClass) return res.status(404).json({ message: 'Not found' });
    res.json({ data: gymClass });
  } catch (err) { next(err); }
};

exports.updateClass = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const payload = pickPayload(req.body);

    // If a new photo was uploaded, swap it in and queue the old one for
    // deletion from Cloudinary — grab the old public_id before it's
    // overwritten.
    let oldPublicId = null;
    if (req.file) {
      const existing = await GymClass.findById(req.params.id).select('image');
      if (!existing) return res.status(404).json({ message: 'Not found' });
      oldPublicId = existing.image?.public_id;
      payload.image = { url: req.file.path, public_id: req.file.filename };
    }

    const updated = await GymClass.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Not found' });

    deleteCloudinaryImage(oldPublicId);

    // A status/date/capacity change can add or remove this class from the
    // public list (see getClasses' Active-and-upcoming filter), so this
    // needs the same "go refetch" broadcast as create/delete rather than
    // a patchable doc.
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
    if (gymClass.attendees.includes(memberId)) return res.status(400).json({ message: 'Already registered' });
    if (gymClass.attendees.length >= gymClass.capacity) return res.status(400).json({ message: 'Class full' });
    gymClass.attendees.push(memberId);
    await gymClass.save();
    await AuditLog.create({ action: 'class_register', userId: memberId, meta: { classId: gymClass._id } });
    // Just a seat count change — every other client with this class
    // already loaded can patch it in place, no need to refetch the list.
    socketUtil.emitToAll('class:updated', gymClass);
    res.json({ message: 'Registered', gymClass });
  } catch (err) { next(err); }
};

exports.cancelRegistration = async (req, res, next) => {
  try {
    const memberId = req.user._id;
    const gymClass = await GymClass.findById(req.params.id);
    if (!gymClass) return res.status(404).json({ message: 'Class not found' });
    gymClass.attendees = gymClass.attendees.filter(a => a.toString() !== memberId.toString());
    await gymClass.save();
    await AuditLog.create({ action: 'class_cancel', userId: memberId, meta: { classId: gymClass._id } });
    socketUtil.emitToAll('class:updated', gymClass);
    res.json({ message: 'Cancelled', gymClass });
  } catch (err) { next(err); }
};