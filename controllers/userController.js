const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const passwordChangeOtpService = require('../services/passwordChangeOtpService');

// Standalone acknowledge endpoint
const acknowledgePrivacyNotice = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.privacyNoticeAcknowledged) {
      user.privacyNoticeAcknowledged = true;
      user.privacyNoticeAcknowledgedAt = new Date();
      await user.save();
    }

    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

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

    const { fullname, email, age, heightCm, weightKg, sex, calorieGoal, address, phone, birthDate, facebookUrl, instagramUrl,
      medicalConditions, medicalAllergies, emergencyContactName, emergencyContactPhone, medicalNotes, medicalConsent,
      privacyNoticeAcknowledged } = req.body;

    user.fullname = fullname;

    // phone/address are the "personal information" fields this page can change post-signup
    // Same accept-in-this-request- or-already-acknowledged pattern as medicalConsent below
    const contactFieldsTouched =
      (address !== undefined && address !== user.address) || (phone !== undefined && phone !== user.phone);
    // Privacy Notice acknowledgment is a member (role 'user') consent flow
    if (user.role === 'user' && contactFieldsTouched && !user.privacyNoticeAcknowledged && !privacyNoticeAcknowledged) {
      return res.status(400).json({
        success: false,
        message: 'Please acknowledge the Privacy Notice before saving this information.',
      });
    }
    if (!user.privacyNoticeAcknowledged && privacyNoticeAcknowledged) {
      user.privacyNoticeAcknowledged = true;
      user.privacyNoticeAcknowledgedAt = new Date();
    }

    if (address !== undefined) user.address = address;
    if (age !== undefined) user.age = age;
    if (heightCm !== undefined) user.heightCm = heightCm;
    if (weightKg !== undefined) user.weightKg = weightKg;
    if (sex !== undefined) user.sex = sex || undefined;
    if (calorieGoal !== undefined) user.calorieGoal = calorieGoal;
    if (phone !== undefined) user.phone = phone;
    if (facebookUrl !== undefined) user.facebookUrl = facebookUrl.trim();
    if (instagramUrl !== undefined) user.instagramUrl = instagramUrl.trim();
    if (birthDate !== undefined) user.birthDate = birthDate || null;

    const medicalFieldsTouched = [medicalConditions, medicalAllergies, emergencyContactName, emergencyContactPhone, medicalNotes]
      .some((v) => v !== undefined);
    if (medicalFieldsTouched) {
      if (user.role === 'user' && !user.medicalConsentGiven && !medicalConsent) {
        return res.status(400).json({
          success: false,
          message: 'Please check the consent box before saving medical information.',
        });
      }
      if (!user.medicalConsentGiven && medicalConsent) {
        user.medicalConsentGiven = true;
        user.medicalConsentDate = new Date();
      }
      if (medicalConditions !== undefined) user.medicalConditions = medicalConditions;
      if (medicalAllergies !== undefined) user.medicalAllergies = medicalAllergies;
      if (emergencyContactName !== undefined) user.emergencyContactName = emergencyContactName;
      if (emergencyContactPhone !== undefined) user.emergencyContactPhone = emergencyContactPhone;
      if (medicalNotes !== undefined) user.medicalNotes = medicalNotes;
    }

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
      data: safeUser,
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

    // Multer parses non-file form fields into req.body same as a JSON request
    // Same admin exemption as updateProfile above — an admin never sees the Privacy Notice modal
    if (user.role === 'user' && !user.privacyNoticeAcknowledged && req.body.privacyNoticeAcknowledged !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'Please acknowledge the Privacy Notice before uploading a photo.',
      });
    }
    if (!user.privacyNoticeAcknowledged && req.body.privacyNoticeAcknowledged === 'true') {
      user.privacyNoticeAcknowledged = true;
      user.privacyNoticeAcknowledgedAt = new Date();
    }

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

// Fire-and-forget cleanup for the old medical document
function deleteCloudinaryMedicalDocument(doc) {
  if (!doc?.public_id) return;
  cloudinary.uploader
    .destroy(doc.public_id, { resource_type: doc.resourceType || 'image', type: 'authenticated' })
    .catch((err) => {
      console.error('Failed to delete old medical document from Cloudinary:', err.message);
    });
}

const uploadMedicalDocument = async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, message: 'At least one file is required.' });

    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Section D1/UI Spec §2
    if (req.body.privacyNoticeAcknowledged !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'Please acknowledge the Privacy Notice before uploading medical documents.',
      });
    }
    // Still recorded on the account (same field Section D1 uses elsewhere) so other
    if (!user.privacyNoticeAcknowledged) {
      user.privacyNoticeAcknowledged = true;
      user.privacyNoticeAcknowledgedAt = new Date();
    }

    const newDocuments = files.map((file) => ({
      url: file.path,
      public_id: file.filename,
      resourceType: file.resource_type || 'image',
      fileName: file.originalname,
      fileType: file.mimetype,
      fileSize: file.size,
      uploadedAt: new Date(),
    }));

    // Additive
    user.medicalDocuments.push(...newDocuments);
    await user.save();

    const safeUser = user.toObject();
    delete safeUser.password;

    res.json({
      success: true,
      message: files.length > 1 ? `${files.length} documents uploaded successfully.` : 'Medical document uploaded successfully.',
      data: safeUser,
    });
  } catch (error) {
    next(error);
  }
};

// Shared by the self-service view below and adminController.getMemberMedicalDocument
// Shared by the self-service view below and adminController.getMemberMedicalDocument — same "mint a fresh signed URL
function buildMedicalDocumentResponse(medicalDocument) {
  if (!medicalDocument?.public_id) return null;

  const { public_id: publicId, resourceType, fileName, fileType, uploadedAt } = medicalDocument;

  const signedUrl = cloudinary.url(publicId, {
    resource_type: resourceType || 'image',
    type: 'authenticated',
    sign_url: true,
    secure: true,
    // NOTE
  });

  return { url: signedUrl, fileName, fileType, uploadedAt };
}

// Returns a short-lived signed URL rather than ever persisting/handing out a directly-usable link
const viewMedicalDocument = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.docId)) {
      return res.status(400).json({ success: false, message: 'Invalid document id.' });
    }
    const user = await User.findById(req.user._id).select('medicalDocuments');
    const document = user?.medicalDocuments?.id(req.params.docId);
    const result = buildMedicalDocumentResponse(document);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const deleteMedicalDocument = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.docId)) {
      return res.status(400).json({ success: false, message: 'Invalid document id.' });
    }
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const document = user.medicalDocuments.id(req.params.docId);
    if (!document?.public_id) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    const oldDocument = { ...document.toObject() };
    document.deleteOne();
    await user.save();

    deleteCloudinaryMedicalDocument(oldDocument);

    const safeUser = user.toObject();
    delete safeUser.password;

    res.json({ success: true, message: 'Medical document removed.', data: safeUser });
  } catch (error) {
    next(error);
  }
};

const getSocialAccounts = async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: {
        gmail: { connected: true, detail: req.user.email },
        facebook: { connected: !!req.user.facebookUrl, detail: req.user.facebookUrl || null },
        instagram: { connected: !!req.user.instagramUrl, detail: req.user.instagramUrl || null },
      },
    });
  } catch (error) {
    next(error);
  }
};

// Send/Resend the verification code to the member's own registered email
const sendPasswordChangeOtp = async (req, res, next) => {
  try {
    const result = await passwordChangeOtpService.requestPasswordChangeOtp(req.user._id);
    res.json({ success: true, message: `Verification code sent to ${result.sentTo}`, data: result });
  } catch (error) {
    next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { currentPassword, newPassword, otp } = req.body;
    await passwordChangeOtpService.verifyAndChangePassword({
      userId: req.user._id,
      currentPassword,
      newPassword,
      otp,
    });

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

// Dashboard support

// ISO week key (Mon–Sun buckets) so "active streak" counts consecutive weeks with at least one visit
const isoWeekKey = (input) => {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  const dayNum = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dayNum + 3);
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
    // One count per gym DAY (Manila), not per session
    { $group: { _id: { m: { $month: { date: '$checkIn', timezone: 'Asia/Manila' } }, d: { $dateToString: { format: '%Y-%m-%d', date: '$checkIn', timezone: 'Asia/Manila' } } } } },
    { $group: { _id: '$_id.m', count: { $sum: 1 } } },
  ]);

  const counts = new Array(12).fill(0);
  results.forEach((r) => { counts[r._id - 1] = r.count; });
  return counts;
};

// Single combined endpoint for the member Dashboard
const getDashboardSummary = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    const [rfidCard, subscription, activeRows, recentVisits, monthlyAttendance, streakWeeks] = await Promise.all([
      RFIDCard.findOne({ userId }),
      Subscription.findOne({ userId, status: 'active' }).sort({ endDate: -1 }).populate('planId'),
      Subscription.find({ userId, status: 'active' }).select('startDate endDate'),
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
              startDate: (require('../services/subscriptionService').getCoverageWindow(activeRows) || subscription).startDate,
              endDate: subscription.endDate,
              // Session Remaining (Group 3)
              sessionsUsed: subscription.sessionsUsed || 0,
            }
          : null,
        activeStreakWeeks: streakWeeks,
        monthlyAttendance,
        recentVisits: recentVisits.map((a) => ({
          _id: a._id,
          checkIn: a.checkIn,
          checkOut: a.checkOut,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Full attendance history for the signed-in member: EVERY session is its own row
const getAttendanceHistory = async (req, res, next) => {
  try {
    const history = require('../services/attendanceHistoryService');
    const { parsePagination } = require('../utils/paginate');
    const { page, limit, skip } = parsePagination({ page: req.query.page, limit: req.query.limit || 10 });

    const filter = { userId: req.user._id };
    const df = history.dateFilter(req.query.startDate, req.query.endDate);
    if (!df.ok) return res.status(400).json({ success: false, message: df.message });
    if (df.range) filter.createdAt = df.range;

    const dir = req.query.sort === 'asc' ? 1 : -1;
    const [rows, total] = await Promise.all([
      Attendance.find(filter).sort({ checkIn: dir, _id: dir }).skip(skip).limit(limit).lean(),
      Attendance.countDocuments(filter),
    ]);
    const data = (await history.decorate(rows)).map((a) => ({
      _id: a._id,
      checkIn: a.checkIn,
      checkOut: a.checkOut || null,
      status: a.status,
      sessionNo: a.sessionNo,
      sessionsThatDay: a.sessionsThatDay,
    }));

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAttendanceHistory,
  getProfile,
  acknowledgePrivacyNotice,
  updateProfile,
  uploadProfilePhoto,
  uploadMedicalDocument,
  viewMedicalDocument,
  deleteMedicalDocument,
  getSocialAccounts,
  sendPasswordChangeOtp,
  changePassword,
  getSubscriptions,
  getDashboardSummary,
  buildMedicalDocumentResponse,
};