const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const RFIDCard = require('../models/RFIDCard');
const Attendance = require('../models/Attendance');
const Subscription = require('../models/Subscription');
const authService = require('../services/authService');
const emailService = require('../services/emailService');

// Section D1: standalone acknowledge endpoint, for gated actions that
// don't have a convenient body field of their own to carry the flag on
// (student ID upload's file field is the whole request; the coach
// registration questionnaire is a separate controller entirely). The
// frontend calls this first, then retries the original action —
// updateProfile/uploadProfilePhoto/uploadMedicalDocument above also
// accept the flag inline in the same request as a shortcut, but this
// endpoint is what actually flips the bit in all cases.
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

    // Section D1: phone/address are the "personal information" fields
    // this page can change post-signup. Same accept-in-this-request-
    // or-already-acknowledged pattern as medicalConsent below, and the
    // same "reject the whole request rather than silently drop these
    // two fields" reasoning — a member shouldn't see their phone/address
    // save look successful when it was actually skipped.
    // Section D1: compares against the STORED value, not just whether
    // the field is present in the request — the frontend's
    // buildProfilePayload() sends address/phone on every save
    // regardless of whether they changed, so a presence-only check here
    // would gate every single profile update (even just editing
    // fullname) behind the privacy notice, not only ones that actually
    // touch contact info.
    const contactFieldsTouched =
      (address !== undefined && address !== user.address) || (phone !== undefined && phone !== user.phone);
    if (contactFieldsTouched && !user.privacyNoticeAcknowledged && !privacyNoticeAcknowledged) {
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
    // Section D2: needed for the Mifflin-St Jeor calorie calculation.
    // checkFalsy in the route validator lets an empty string clear it
    // back to unset, same convention as facebookUrl/instagramUrl below.
    if (sex !== undefined) user.sex = sex || undefined;
    if (calorieGoal !== undefined) user.calorieGoal = calorieGoal;
    if (phone !== undefined) user.phone = phone;
    // Empty string clears the link (used by the "Disconnect" action on the
    // frontend); a non-empty value is already URL-validated by the route.
    if (facebookUrl !== undefined) user.facebookUrl = facebookUrl.trim();
    if (instagramUrl !== undefined) user.instagramUrl = instagramUrl.trim();
    // birthDate arrives as a 'YYYY-MM-DD' string from the frontend's
    // <input type="date">; Mongoose casts it to the schema's Date type
    // automatically, same as any other Date-typed field assignment here.
    if (birthDate !== undefined) user.birthDate = birthDate || null;

    // Medical fields (Section H) — any of them arriving requires consent,
    // either already on file from a previous save or given in this same
    // request (medicalConsent: true in the body, from the profile form's
    // checkbox). Without that, the whole request is rejected rather than
    // silently dropping the medical fields and saving everything else —
    // a partial save here could look to the member like their medical
    // info was recorded when it wasn't.
    const medicalFieldsTouched = [medicalConditions, medicalAllergies, emergencyContactName, emergencyContactPhone, medicalNotes]
      .some((v) => v !== undefined);
    if (medicalFieldsTouched) {
      if (!user.medicalConsentGiven && !medicalConsent) {
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

    // Section D1: multer parses non-file form fields into req.body same
    // as a JSON request — 'true'/'false' arrive as strings here since
    // this is multipart/form-data, not JSON, hence the explicit === check.
    if (!user.privacyNoticeAcknowledged && req.body.privacyNoticeAcknowledged !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'Please acknowledge the Privacy Notice before uploading a photo.',
      });
    }
    if (!user.privacyNoticeAcknowledged) {
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

// Fire-and-forget cleanup for the old medical document, mirroring
// deleteCloudinaryImage() above but resource_type-aware since a medical
// document can be a PDF (resource_type 'raw'/'image' depending on how
// Cloudinary classified it at upload time) rather than always an image.
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
    if (!req.file) return res.status(400).json({ success: false, message: 'A file is required.' });

    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Section D1: this endpoint had no consent gate at all before —
    // noted as a gap during the C4 fix (document upload wasn't behind
    // the same medicalConsentGiven check as the free-text medical
    // fields). Using the broader privacy notice flag here rather than
    // medicalConsentGiven since D1 is meant to cover this specific case
    // by name ("medical document upload") separately from that
    // narrower, already-existing consent.
    if (!user.privacyNoticeAcknowledged && req.body.privacyNoticeAcknowledged !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'Please acknowledge the Privacy Notice before uploading a medical document.',
      });
    }
    if (!user.privacyNoticeAcknowledged) {
      user.privacyNoticeAcknowledged = true;
      user.privacyNoticeAcknowledgedAt = new Date();
    }

    const oldDocument = user.medicalDocument?.public_id ? { ...user.medicalDocument.toObject?.() ?? user.medicalDocument } : null;

    user.medicalDocument = {
      url: req.file.path,
      public_id: req.file.filename,
      resourceType: req.file.resource_type || 'image',
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      uploadedAt: new Date(),
    };
    await user.save();

    deleteCloudinaryMedicalDocument(oldDocument);

    const safeUser = user.toObject();
    delete safeUser.password;

    res.json({ success: true, message: 'Medical document uploaded successfully.', data: safeUser });
  } catch (error) {
    next(error);
  }
};

// Shared by the self-service view below and adminController.getMemberMedicalDocument
// — same "mint a fresh signed URL, never persist/hand out a raw one"
// approach for both, just called with a different owner's document.
// Takes the medicalDocument sub-document (or null) and returns the
// { url, fileName, fileType, uploadedAt } shape both callers respond
// with, or null if there's nothing on file.
function buildMedicalDocumentResponse(medicalDocument) {
  if (!medicalDocument?.public_id) return null;

  const { public_id: publicId, resourceType, fileName, fileType, uploadedAt } = medicalDocument;

  const signedUrl = cloudinary.url(publicId, {
    resource_type: resourceType || 'image',
    type: 'authenticated',
    sign_url: true,
    secure: true,
    // NOTE: sign_url alone does not make this link expire — it just
    // proves the URL was generated by someone holding the API secret,
    // which is what keeps `authenticated`-type assets from being
    // guessable/publicly listable. The URL is still valid indefinitely
    // once generated. If time-boxed links are needed later, enable
    // Cloudinary's "strict token authentication" and switch this to an
    // auth_token with a `start_time`/`duration` instead.
  });

  return { url: signedUrl, fileName, fileType, uploadedAt };
}

// Returns a short-lived signed URL rather than ever persisting/handing out
// a directly-usable link — see the comment on medicalDocument in User.js
// and on medicalDocumentStorage in uploadMiddleware.js. Owner-only here;
// staff access goes through adminController.getMemberMedicalDocument
// instead, which reuses buildMedicalDocumentResponse above rather than
// this route being relaxed to accept an arbitrary id.
const viewMedicalDocument = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('medicalDocument');
    const result = buildMedicalDocumentResponse(user?.medicalDocument);
    if (!result) {
      return res.status(404).json({ success: false, message: 'No medical document on file.' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const deleteMedicalDocument = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.medicalDocument?.public_id) {
      return res.status(404).json({ success: false, message: 'No medical document on file.' });
    }

    const oldDocument = { ...(user.medicalDocument.toObject?.() ?? user.medicalDocument) };
    user.medicalDocument = undefined;
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

module.exports = {
  getProfile,
  acknowledgePrivacyNotice,
  updateProfile,
  uploadProfilePhoto,
  uploadMedicalDocument,
  viewMedicalDocument,
  deleteMedicalDocument,
  getSocialAccounts,
  changePassword,
  getSubscriptions,
  getDashboardSummary,
  buildMedicalDocumentResponse,
};