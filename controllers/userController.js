const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const authService = require('../services/authService');
const emailService = require('../services/emailService');

const getProfile = async (req, res, next) => {
  try {
    res.json({ success: true, data: req.user });
  } catch (error) {
    next(error);
  }
};

// Fire-and-forget Cloudinary cleanup for user profile photos
const cloudinary = require('../config/cloudinary');
function deleteCloudinaryImage(publicId) {
  if (!publicId) return;
  cloudinary.uploader.destroy(publicId).catch((err) => {
    console.error('Failed to delete old user photo from Cloudinary:', err.message);
  });
}

const updateProfile = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { fullname, email, age, heightCm, weightKg, address } = req.body;

    user.fullname = fullname;
    if (address !== undefined) user.address = address;
    if (age !== undefined) user.age = age;
    if (heightCm !== undefined) user.heightCm = heightCm;
    if (weightKg !== undefined) user.weightKg = weightKg;

    let emailChanged = false;
    if (email && email.toLowerCase() !== user.email) {
      const existing = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
      if (existing) return res.status(409).json({ success: false, message: 'Email is already in use' });
      user.email = email.toLowerCase();
      user.isVerified = false;
      emailChanged = true;
    }

    await user.save();

    let verificationSent = false;
    if (emailChanged) {
      const verificationToken = await authService.createVerificationToken(user);
      const verifyUrl = `${process.env.CLIENT_URL}/verify-email/${verificationToken}`;
      emailService.sendVerificationEmail(user, verifyUrl).catch((err) =>
        console.error('Failed to send verification email:', err.message)
      );
      verificationSent = true;
    }

    const safeUser = user.toObject();
    delete safeUser.password;

    res.json({
      success: true,
      message: verificationSent
        ? 'Profile updated successfully. Please verify your new email address.'
        : 'Profile updated successfully.',
      data: safeUser,   // full user object, matching frontend's res.data.data usage
    });
  } catch (error) {
    next(error);
  }
};

const uploadProfilePhoto = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Photo file is required' });

    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const oldPublicId = user.photo?.public_id;
    user.photo = { url: req.file.path, public_id: req.file.filename };
    await user.save();

    deleteCloudinaryImage(oldPublicId);

    const safeUser = user.toObject();
    delete safeUser.password;

    res.json({ success: true, message: 'Photo uploaded successfully.', data: safeUser });
  } catch (error) {
    next(error);
  }
};

const getSocialAccounts = async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: {
        gmail: { connected: false },
        facebook: { connected: false },
        instagram: { connected: false },
      },
    });
  } catch (error) {
    next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

    user.password = newPassword; // pre-save hook rehashes
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
};

const getSubscriptions = async (req, res, next) => {
  try {
    const subscriptions = await require('../models/Subscription')
      .find({ userId: req.user._id })
      .populate('planId')
      .populate('paymentId')
      .lean();

    const response = subscriptions.map((sub) => ({
      membershipName: sub.planId?.name || null,
      membershipType: sub.planId?.duration || null,
      status: sub.status,
      startDate: sub.startDate,
      endDate: sub.endDate,
      expirationDate: sub.endDate,
      paymentStatus: sub.paymentId?.status || null,
    }));

    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
};

// ---- Dashboard support ----

// ISO week key (Mon–Sun buckets) so "active streak" counts consecutive
// weeks with at least one visit, regardless of which day the visit fell on.
const isoWeekKey = (input) => {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  const dayNum = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - dayNum + 3); // move to Thursday of this week
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  const diff = date - firstThursday;
  const week = 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
  return `${date.getFullYear()}-${week}`;
};

const getActiveStreakWeeks = async (userId) => {
  const attendances = await Attendance.find({ userId }).select('checkIn').lean();
  if (!attendances.length) return 0;

  const weeksWithVisits = new Set(attendances.map((a) => isoWeekKey(a.checkIn)));

  let streak = 0;
  const cursor = new Date();
  while (weeksWithVisits.has(isoWeekKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 7);
  }
  return streak;
};

const getMonthlyAttendanceCounts = async (userId, year) => {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31, 23, 59, 59, 999);

  const results = await Attendance.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId), checkIn: { $gte: start, $lte: end } } },
    { $group: { _id: { $month: '$checkIn' }, count: { $sum: 1 } } },
  ]);

  const counts = new Array(12).fill(0);
  results.forEach((r) => { counts[r._id - 1] = r.count; });
  return counts;
};

// Single combined endpoint for the member Dashboard so the page doesn't
// have to fan out into 5 separate requests on load.
const getDashboardSummary = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    const [rfidCard, subscription, recentVisits, monthlyAttendance, streakWeeks] = await Promise.all([
      RFIDCard.findOne({ userId }),
      Subscription.findOne({ userId, status: 'active' }).sort({ endDate: -1 }).populate('planId'),
      Attendance.find({ userId }).sort({ checkIn: -1 }).limit(10),
      getMonthlyAttendanceCounts(userId, year),
      getActiveStreakWeeks(userId),
    ]);

    res.json({
      success: true,
      data: {
        profile: {
          fullname: req.user.fullname,
          age: req.user.age ?? null,
          heightCm: req.user.heightCm ?? null,
          weightKg: req.user.weightKg ?? null,
          calorieGoal: req.user.calorieGoal ?? null,
        },
        rfid: {
          bound: !!rfidCard,
          cardId: rfidCard ? rfidCard.cardId : null,
          active: rfidCard ? rfidCard.active : false,
        },
        subscription: subscription
          ? {
              planName: subscription.planId?.name || null,
              startDate: subscription.startDate,
              endDate: subscription.endDate,
            }
          : null,
        activeStreakWeeks: streakWeeks,
        monthlyAttendance, // 12-entry array, index 0 = January
        recentVisits: recentVisits.map((a) => ({
          checkIn: a.checkIn,
          checkOut: a.checkOut,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getProfile, updateProfile, uploadProfilePhoto, getSocialAccounts, changePassword, getSubscriptions, getDashboardSummary };