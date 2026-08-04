const StudentVerification = require('../models/StudentVerification');
const Notification = require('../models/Notification');
const socketUtil = require('../utils/socket');

const submit = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'ID photo is required' });

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