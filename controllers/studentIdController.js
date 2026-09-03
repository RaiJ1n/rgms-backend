const StudentVerification = require('../models/StudentVerification');
const Notification = require('../models/Notification');
const User = require('../models/User');
const socketUtil = require('../utils/socket');

const submit = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'ID photo is required' });

    // Section D1: an ID photo is exactly the kind of sensitive document
    // this notice is meant to cover. req.user here is the version
    // authMiddleware fetched at the start of the request, so it may not
    // reflect an acknowledgment made moments earlier in the same
    // session — re-fetch rather than trust the stale copy.
    const user = await User.findById(req.user._id).select('privacyNoticeAcknowledged');
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