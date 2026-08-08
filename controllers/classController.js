const { validationResult } = require('express-validator');
const GymClass = require('../models/GymClass');
const AuditLog = require('../models/AuditLog');
const cloudinary = require('../config/cloudinary');
const socketUtil = require('../utils/socket');
const escapeRegex = require('../utils/escapeRegex');
const { parsePagination } = require('../utils/paginate');

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

// ---- Auto Active -> Completed ----
// date is a Date (Y-M-D, time component unused), startTime/endTime are
// 'HH:mm' <input type="time"> strings. Combined the same way the rest of
// this controller already treats dates — server-local time via setHours
// (see registerMember's startOfToday.setHours(0,0,0,0)) — so this stays
// consistent with the app's existing (implicit, no-timezone-library)
// date handling rather than introducing a new convention.
function getClassEndDateTime(gymClass) {
  const end = new Date(gymClass.date);
  const [hours, minutes] = (gymClass.endTime || '00:00').split(':').map(Number);
  end.setHours(hours || 0, minutes || 0, 0, 0);
  return end;
}

// Cancelled classes are left alone — only a class currently marked
// Active can silently expire into Completed. Runs before every list/read
// so status is correct in the database itself (not just computed for
// display), matching what's shown after a refresh and what any other
// endpoint (registration, admin edit) sees.
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

// Fields an admin can set from the create/edit form. Kept in one list so
// createClass/updateClass can't drift apart, and so findByIdAndUpdate
// only ever touches fields we actually meant to expose (not attendees,
// not image — image is handled separately below from req.file).
const ALLOWED_FIELDS = ['name', 'description', 'instructor', 'date', 'startTime', 'endTime', 'status', 'capacity'];

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
    await syncCompletedClasses();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const classes = await GymClass.find({ status: 'Active', date: { $gte: startOfToday } })
      .sort({ date: 1, startTime: 1 });
    res.json({ data: classes });
  } catch (err) { next(err); }
};

// Admin-facing list (AdminClasses.vue) — everything, regardless of
// status or date, so the admin can see past/cancelled classes too.
// AdminClasses.vue sends page/limit/search and reads back
// data/total/totalPages — matching the same shape as
// adminController.getMembers/getPayments — but this endpoint previously
// ignored all of that and always returned the full unfiltered list.
exports.getAllClassesAdmin = async (req, res, next) => {
  try {
    await syncCompletedClasses();

    const { page, limit, skip, isExport } = parsePagination(req.query);
    const { search } = req.query;

    const filter = {};
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: re }, { instructor: re }];
    }

    const total = await GymClass.countDocuments(filter);
    const classes = await GymClass.find(filter)
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
    const gymClass = await GymClass.findById(req.params.id);
    if (!gymClass) return res.status(404).json({ message: 'Not found' });
    res.json({ data: gymClass });
  } catch (err) { next(err); }
};

// ---- View: registered members for a class (AdminClasses.vue "View") ----
// Class registration in this app is tracked entirely by GymClass.attendees
// (see registerMember below) — Payment.js has no classId and
// registerMember never creates a Payment record, so there is no existing
// class<->Payment link to reuse. attendees IS the registration system, so
// this reads from it directly rather than inventing a second one. See the
// note in my reply about what that means for the Payment/Date columns
// the spec asked for.
exports.getClassMembers = async (req, res, next) => {
  try {
    await syncCompletedClasses();
    const gymClass = await GymClass.findById(req.params.id)
      .populate('attendees', 'fullname email phone');
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
    // Covers the same-day case: date is still >= today but the class's
    // own end time already passed (e.g. registering at 6:15 PM for a
    // class that ended at 6:00 PM) — status may not have flipped to
    // Completed yet if syncCompletedClasses hasn't run since then.
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
    );
if (!updated) return res.status(400).json({ message: 'Unable to register (full, already registered, or closed)' });
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