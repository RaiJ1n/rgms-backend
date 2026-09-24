const StudentVerification = require('../models/studentVerification');
const Notification = require('../models/Notification');
const User = require('../models/User');
const socketUtil = require('../utils/socket');

const submit = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'ID photo is required' });

    // The storage engine populates these from the Cloudinary response. If it
    // is ever misconfigured again (see config/cloudinary.js), multer hands us
    // a req.file with neither field set and throws nothing — without this
    // guard that surfaces as an opaque Mongoose "Path `imageUrl` is required"
    // validation error on the create() below, which points at the wrong file.
    if (!req.file.path || !req.file.filename) {
      return res.status(502).json({
        success: false,
        message: 'Upload to storage failed. Please try again.',
      });
    }

    // Section D1: an ID photo is exactly the kind of sensitive document
    // this notice is meant to cover. req.user here is the version
    // authMiddleware fetched at the start of the request, so it may not
    // reflect an acknowledgment made moments earlier in the same
    // session — re-fetch rather than trust the stale copy.
    const user = await User.findById(req.user._id).select('privacyNoticeAcknowledged');
    // protect guarantees the account existed when the request started, not
    // that it still does — a delete mid-request would otherwise throw here.
    if (!user) {
      return res.status(401).json({ success: false, message: 'Not authorized, user not found' });
    }
    if (!user.privacyNoticeAcknowledged && req.body.privacyNoticeAcknowledged !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'Please acknowledge the Privacy Notice before uploading your ID.',
      });
    }
    if (!user.privacyNoticeAcknowledged) {
      user.privacyNoticeAcknowledged = true;
      user.privacyNoticeAcknowledgedAt = new Date();
      await user.save();
    }

    const existingPending = await StudentVerification.findOne({ userId: req.user._id, status: 'pending' });
    if (existingPending) {
      return res.status(400).json({ success: false, message: 'You already have a submission awaiting review' });
    }

    const submission = await StudentVerification.create({
      userId: req.user._id,
      imageUrl: req.file.path,
      publicId: req.file.filename,
      status: 'pending',
    });

    Notification.create({
      type: 'student_id',
      message: `${req.user.fullname} submitted a student ID for verification`,
      userId: req.user._id,
      studentVerificationId: submission._id,
    })
      .then((notification) => socketUtil.emitToAdmins('notification:new', notification))
      .catch((err) => console.error('Failed to create student-id notification:', err.message));

    res.status(201).json({ success: true, message: 'Student ID submitted for review', data: submission });
  } catch (error) {
    next(error);
  }
};

const getMyStatus = async (req, res, next) => {
  try {
    const latest = await StudentVerification.findOne({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: latest });
  } catch (error) {
    next(error);
  }
};

module.exports = { submit, getMyStatus };