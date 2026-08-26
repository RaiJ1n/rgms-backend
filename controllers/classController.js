const { validationResult } = require('express-validator');
const GymClass = require('../models/GymClass');
// Coaches are User documents with role: 'coach' — not a separate
// collection. models/Coach.js is deprecated (exports {}, no
// mongoose.model registered under 'Coach'), so any Coach.findById/find
// call here would throw "Coach.findById is not a function". Use User,
// scoped to role: 'coach', the same way coachController.js already does.
const User = require('../models/User');
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

// What a populated instructorId looks like on every response below —
// kept to just what the frontend needs to display (name + specialty),
// same reasoning as getClassMembers only projecting fullname/email/phone
// off a member rather than returning the whole User doc.
const INSTRUCTOR_POPULATE = { path: 'instructorId', select: 'fullname specialization' };

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
// 'instructor' (free-text) replaced with 'instructorId' (Coach reference).
const ALLOWED_FIELDS = ['name', 'description', 'instructorId', 'date', 'startTime', 'endTime', 'status', 'capacity'];

function pickPayload(body) {
  const payload = {};
  for (const key of ALLOWED_FIELDS) {
    // Previously also skipped '' , which meant clearing an optional field
    // (e.g. wiping out Description in the edit form) had no effect — the
    // old value stayed in the database with no error shown. Required
    // fields (name/date/startTime/endTime) can't reach here as '' anyway:
    // express-validator's notEmpty() rules on the route reject that
    // before the controller runs.
    //
    // instructorId is the one exception: '' is a deliberate "unassign
    // the instructor" signal from the edit form's "— Unassigned —" option,
    // and must be converted to `undefined` (not saved as the string ''),
    // since the schema expects an ObjectId or nothing.
    if (body[key] === '' && key === 'instructorId') {
      payload.instructorId = undefined;
      continue;
    }
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

// express-validator's isMongoId() only checks the shape of the string —
// it says nothing about whether that id belongs to a real, active Coach.
// Without this, a class could end up assigned to a deleted/deactivated
// coach, or to any well-formed ObjectId at all.
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
      .populate(INSTRUCTOR_POPULATE)
      .sort({ date: 1, startTime: 1 });
    res.json({ data: classes });
  } catch (err) { next(err); }
};

// Admin-facing list (AdminClasses.vue) — everything, regardless of
// status or date, so the admin can see past/cancelled classes too.
// AdminClasses.vue sends page/limit/search and reads back
// data/total/totalPages — matching the same shape as
// adminController.getMembers/getPayments.
exports.getAllClassesAdmin = async (req, res, next) => {
  try {
    await syncCompletedClasses();

    const { page, limit, skip, isExport } = parsePagination(req.query);
    const { search } = req.query;

    const filter = {};
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      // instructorId is now a reference, not free text, so a regex can't
      // match it directly the way { instructor: re } used to. Resolve
      // matching coach names to their _ids first, then search classes by
      // name OR by one of those instructor ids — two queries instead of
      // one, but no change to the find()-based pattern used everywhere
      // else in this controller (no aggregation pipeline needed).
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

// ---- View: registered members for a class (AdminClasses.vue "View") ----
// Class registration in this app is tracked entirely by GymClass.attendees
// (see registerMember below) — Payment.js has no classId and
// registerMember never creates a Payment record, so there is no existing
// class<->Payment link to reuse. attendees IS the registration system, so
// this reads from it directly rather than inventing a second one.
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

    const updated = await GymClass.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true })
      .populate(INSTRUCTOR_POPULATE);
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
    ).populate(INSTRUCTOR_POPULATE);
if (!updated) return res.status(400).json({ message: 'Unable to register (full, already registered, or closed)' });
    await AuditLog.create({ action: 'class_register', userId: memberId, meta: { classId: gymClass._id } });
    // Just a seat count change — every other client with this class
    // already loaded can patch it in place, no need to refetch the list.
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