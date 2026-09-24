const { validationResult } = require('express-validator');
const GymClass = require('../models/GymClass');
const User = require('../models/User');
const CoachRegistrationRequest = require('../models/CoachRegistrationRequest');
const Notification = require('../models/Notification');
const WorkoutPlan = require('../models/Workoutplan');
const WorkoutPlanProgress = require('../models/WorkoutPlanProgress');
const cloudinary = require('../config/cloudinary');
const socketUtil = require('../utils/socket');
// Shared with the member's own medical-document view (Section 4:
// "Medical Documents" on the Client Details page a coach sees) — reuses
// the exact same "mint a fresh signed URL, never persist/hand out a raw
// one" helper rather than duplicating it, same reasoning as
// adminController.getMemberMedicalDocument reusing it for the admin side.
const { buildMedicalDocumentResponse } = require('./userController');
const passwordChangeOtpService = require('../services/passwordChangeOtpService');
const { generateOtp, hashOtp } = require('../utils/generateOtp');
const emailService = require('../services/emailService');

// Fire-and-forget Cloudinary cleanup, same helper/pattern as
// userController.js's deleteCloudinaryImage — kept as a local copy here
// rather than exported/shared since it's a two-line utility, not shared
// state.
function deleteCloudinaryImage(publicId) {
  if (!publicId) return;
  cloudinary.uploader.destroy(publicId).catch((err) => {
    console.error('Failed to delete old coach photo from Cloudinary:', err.message);
  });
}

// Everything here runs behind protectCoach (see coachRoutes.js) — req.coach
// is the authenticated coach, never taken from a param or body. A coach
// can only ever see their own classes, never another coach's, and never
// by guessing an id — getMyClassRoster below double-checks this even
// though the query itself already scopes to req.coach._id.

const getMyClasses = async (req, res, next) => {
  try {
    const classes = await GymClass.find({ instructorId: req.coach._id })
      .sort({ date: -1, startTime: 1 });

    res.json({ success: true, data: classes });
  } catch (error) {
    next(error);
  }
};

// Roster for one of this coach's own classes. Reuses the same
// attendees->members shape as adminController.getClassMembers so the
// frontend list-rendering logic can be shared/consistent, but this is a
// deliberately separate endpoint (not the admin one reused with a looser
// middleware) — a coach must never be able to view another coach's roster
// by id-guessing, which is why instructorId is checked explicitly below
// rather than trusting that only assigned coaches would know a class id.
const getMyClassRoster = async (req, res, next) => {
  try {
    const gymClass = await GymClass.findById(req.params.id)
      .populate('attendees', 'fullname email phone');

    if (!gymClass) return res.status(404).json({ success: false, message: 'Class not found' });

    if (!gymClass.instructorId || gymClass.instructorId.toString() !== req.coach._id.toString()) {
      return res.status(403).json({ success: false, message: 'You are not assigned to this class' });
    }

    const members = gymClass.attendees.map((u) => ({
      _id: u._id,
      name: u.fullname,
      email: u.email,
      phone: u.phone,
    }));

    res.json({
      success: true,
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
  } catch (error) {
    next(error);
  }
};

// ---- Personal Information (Section 5) ----
// req.coach is already the full User document (minus password), fetched
// fresh from the DB by protectCoach on every request — same as
// userController.getProfile just returning req.user directly.
const getMyProfile = async (req, res, next) => {
  try {
    res.json({ success: true, data: req.coach });
  } catch (error) {
    next(error);
  }
};

const updateMyProfile = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const coach = await User.findById(req.coach._id).select('-password');
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    // fullname/email intentionally reuse the same account fields the
    // existing auth system already stores — see the spec's own
    // instruction not to duplicate fields the account system already
    // has. Everything else here is the coach-only fields added to
    // User.js for this feature.
    const {
      fullname,
      age,
      sex,
      phone,
      address,
      occupation,
      fitnessJourney,
      currentFitnessGoal,
      preferredExerciseTime,
    } = req.body;

    if (fullname !== undefined) coach.fullname = fullname;
    if (age !== undefined) coach.age = age;
    if (sex !== undefined) coach.sex = sex;
    if (phone !== undefined) coach.phone = phone;
    if (address !== undefined) coach.address = address;
    if (occupation !== undefined) coach.occupation = occupation;
    if (fitnessJourney !== undefined) coach.fitnessJourney = fitnessJourney;
    if (currentFitnessGoal !== undefined) coach.currentFitnessGoal = currentFitnessGoal;
    if (preferredExerciseTime !== undefined) coach.preferredExerciseTime = preferredExerciseTime;

    await coach.save();
    const safeCoach = coach.toObject();
    delete safeCoach.password;
    res.json({ success: true, message: 'Personal information updated', data: safeCoach });
  } catch (error) {
    next(error);
  }
};

const uploadMyProfilePhoto = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Photo file is required' });

    const coach = await User.findById(req.coach._id).select('-password');
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    const oldPublicId = coach.photo?.public_id;
    coach.photo = { url: req.file.path, public_id: req.file.filename };
    await coach.save();

    deleteCloudinaryImage(oldPublicId);

    const safeCoach = coach.toObject();
    delete safeCoach.password;
    res.json({ success: true, message: 'Photo uploaded successfully.', data: safeCoach });
  } catch (error) {
    next(error);
  }
};

// ---- Settings (Section 1) ----
// Deliberately separate from getMyProfile/updateMyProfile above — those
// are "Personal Information" (public-facing profile shown to clients);
// this is account-level Settings (notification preferences, password),
// same split already used for Client (UserProfile.vue vs Settings.vue)
// and Admin (their own profile section vs the Security section on the
// same page). Kept in this controller rather than a new file since it's
// the same req.coach-scoped, protectCoach-gated pattern as everything
// else here.

const getMySettings = async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: {
        email: req.coach.email,
        notificationEmail: req.coach.notificationEmail || '',
        notificationEmailVerified: req.coach.notificationEmailVerified || false,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Send/Resend the notification-email ownership code (Coach Settings ->
// Notification, Group 8). Sent to the CANDIDATE address itself
// (req.body.email) rather than the coach's own account email, since
// proving the coach can read mail at THAT address is the entire point.
// Same 60s cooldown / 10-minute expiry convention as
// passwordChangeOtpService, kept independent here since it tracks a
// pending value the password flow has no equivalent of.
const sendNotificationEmailOtp = async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Enter an email address first' });
    }

    const coach = await User.findById(req.coach._id);
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    if (coach.notificationEmailOtpLastSentAt) {
      const cooldownMs = 60 * 1000;
      const elapsed = Date.now() - coach.notificationEmailOtpLastSentAt.getTime();
      if (elapsed < cooldownMs) {
        const waitSeconds = Math.ceil((cooldownMs - elapsed) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${waitSeconds}s before requesting another code` });
      }
    }

    const { otp, hashedOtp } = generateOtp();
    coach.notificationEmailOtp = hashedOtp;
    coach.notificationEmailOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
    coach.notificationEmailOtpLastSentAt = new Date();
    coach.notificationEmailPendingValue = email;
    // A fresh code always resets verified state — the previously-saved
    // address (if any) is untouched until Save is clicked with a
    // matching, successfully-verified code.
    coach.notificationEmailVerified = false;
    await coach.save();

    try {
      await emailService.sendNotificationEmailOtpEmail(email, coach.fullname, otp);
    } catch (err) {
      return res.status(502).json({ success: false, message: 'Failed to send verification code. Please try again.' });
    }

    res.json({ success: true, message: `Verification code sent to ${email}` });
  } catch (error) {
    next(error);
  }
};

const updateMySettings = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const coach = await User.findById(req.coach._id).select('-password');
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    const { notificationEmail, otp } = req.body;
    // Empty string is valid here — it's how a coach clears the override
    // and falls back to their login email for notifications. Clearing
    // needs no verification; setting/changing to a real address does.
    if (notificationEmail !== undefined) {
      const normalized = notificationEmail.trim().toLowerCase();

      if (!normalized) {
        coach.notificationEmail = '';
        coach.notificationEmailVerified = false;
        coach.notificationEmailOtp = undefined;
        coach.notificationEmailOtpExpires = undefined;
        coach.notificationEmailOtpLastSentAt = undefined;
        coach.notificationEmailPendingValue = undefined;
      } else if (normalized === coach.notificationEmail && coach.notificationEmailVerified) {
        // Unchanged from the already-verified value — nothing to do.
      } else {
        if (!otp) {
          return res.status(400).json({ success: false, message: 'Please verify this email with the code sent to it first' });
        }
        if (
          coach.notificationEmailPendingValue !== normalized ||
          !coach.notificationEmailOtp ||
          !coach.notificationEmailOtpExpires
        ) {
          return res
            .status(400)
            .json({ success: false, message: 'No verification code was requested for this email. Please click Send Code first.' });
        }
        if (coach.notificationEmailOtpExpires.getTime() < Date.now()) {
          return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
        }
        if (hashOtp(otp) !== coach.notificationEmailOtp) {
          return res.status(400).json({ success: false, message: 'Invalid verification code' });
        }

        coach.notificationEmail = normalized;
        coach.notificationEmailVerified = true;
        // Single-use: clear the code so it can't be replayed.
        coach.notificationEmailOtp = undefined;
        coach.notificationEmailOtpExpires = undefined;
        coach.notificationEmailOtpLastSentAt = undefined;
        coach.notificationEmailPendingValue = undefined;
      }
    }

    await coach.save();
    res.json({
      success: true,
      message: 'Settings updated',
      data: {
        email: coach.email,
        notificationEmail: coach.notificationEmail || '',
        notificationEmailVerified: coach.notificationEmailVerified || false,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Send/Resend the verification code to the coach's own login email.
// Same OTP fields, cooldown and email template as Admin Settings' and
// the member's "Send Code" flow — see passwordChangeOtpService.js.
const sendMyPasswordChangeOtp = async (req, res, next) => {
  try {
    const result = await passwordChangeOtpService.requestPasswordChangeOtp(req.coach._id);
    res.json({ success: true, message: `Verification code sent to ${result.sentTo}`, data: result });
  } catch (error) {
    next(error);
  }
};

// Same current-password-required pattern as userController's
// change-password for members, now also requiring a verified OTP sent
// to the coach's email before the change is allowed — same
// passwordChangeOtpService used by the member flow (Admin Settings has
// its own separate copy of this same pattern in adminService.js).
const changeMyPassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { currentPassword, newPassword, otp } = req.body;
    await passwordChangeOtpService.verifyAndChangePassword({
      userId: req.coach._id,
      currentPassword,
      newPassword,
      otp,
    });

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    next(error);
  }
};

// ---- Client requests (Sections 6/7) ----
// Every query below is scoped to req.coach._id — a coach can only ever
// see or act on their own requests/clients, never another coach's
// (Section 15, rule 6), enforced here server-side rather than trusted
// from the frontend.

const getMyRequests = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { coachId: req.coach._id };
    if (status) filter.status = status;

    const requests = await CoachRegistrationRequest.find(filter)
      .populate('clientId', 'fullname email phone photo')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
};

// Accepted requests only — "current client list" (Section 6/7).
const getMyClients = async (req, res, next) => {
  try {
    const clients = await CoachRegistrationRequest.find({ coachId: req.coach._id, status: 'accepted' })
      .populate('clientId', 'fullname email phone photo')
      .sort({ reviewedAt: -1 });

    res.json({ success: true, data: clients });
  } catch (error) {
    next(error);
  }
};

// ---- Client Details (Section 4: coach viewing one of their own,
// already-accepted clients) ----
//
// Shared guard: only an ACCEPTED CoachRegistrationRequest between this
// coach and this client authorizes access — pending, rejected, or no
// relationship at all must all be treated the same as "not your
// client." This is enforced here, on the backend, rather than trusted
// from whatever list the frontend happens to already be showing —
// Section 6: "A Coach must not be able to access another Coach's
// clients by manually changing a URL, ID, request parameter, or
// frontend state."
async function assertAcceptedClient(coachId, clientId) {
  return CoachRegistrationRequest.findOne({ coachId, clientId, status: 'accepted' });
}

// Fields safe to show THIS client's own coach — includes medical info
// (Section 4 explicitly calls this out), unlike getMyClients' list view
// above, which only needs enough to render a name/avatar row. Still
// excludes password (via .select) and anything not relevant to a coach
// safely customizing this client's classes/programs.
const CLIENT_DETAIL_FIELDS =
  'fullname email phone address photo medicalConditions medicalAllergies emergencyContactName emergencyContactPhone medicalNotes medicalConsentGiven medicalDocuments createdAt';

const getClientDetail = async (req, res, next) => {
  try {
    const relationship = await assertAcceptedClient(req.coach._id, req.params.id);
    // Deliberately the same 404 whether the id doesn't exist, belongs to
    // someone who was never this coach's client, or belongs to another
    // coach's client — same "don't let id-probing distinguish reasons"
    // principle as coachDirectoryController.getDisplayedCoach.
    if (!relationship) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const client = await User.findOne({ _id: req.params.id, role: 'user' }).select(CLIENT_DETAIL_FIELDS);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const safeClient = client.toObject();
    // Medical documents: metadata only (Section 4: "See the list of
    // uploaded medical documents... See the document/file name...").
    // url/public_id are never handed out directly here — they're
    // Cloudinary `authenticated` resources anyway (see User.js) — a
    // coach opening one goes through getClientMedicalDocument below,
    // which mints a fresh signed URL and re-checks this same
    // relationship, same convention as the member's own profile view.
    safeClient.medicalDocuments = (client.medicalDocuments || []).map((doc) => ({
      _id: doc._id,
      fileName: doc.fileName,
      fileType: doc.fileType,
      fileSize: doc.fileSize,
      uploadedAt: doc.uploadedAt,
    }));

    // Questionnaire answers from the registration request itself —
    // already fetched above for the authorization check, so this is
    // free (no extra query). Preserves the "view this client's
    // registration answers" feature the coach-side client list already
    // had, now folded into the one dedicated details view instead of a
    // separate modal.
    safeClient.registrationAnswers = relationship.answers || [];
    safeClient.clientSince = relationship.reviewedAt || relationship.createdAt;

    res.json({ success: true, data: safeClient });
  } catch (error) {
    next(error);
  }
};

// Powers the "Current Workout" tab on Coach -> Client Details (Group 7):
// every plan THIS coach has assigned to this client, each with its
// components (name/sets/reps, snapshotted on the plan) and, alongside
// each component, that client's own progress entry — specifically the
// free-text notes they've left against it (WorkoutPlanProgress.entries),
// since those notes are what the spec means by "Notes left by the
// member/client". Re-checks the same accepted-client relationship as
// getClientDetail/getClientMedicalDocument, independently, for the same
// "each request re-verifies access on its own" reason.
const getClientWorkout = async (req, res, next) => {
  try {
    const relationship = await assertAcceptedClient(req.coach._id, req.params.id);
    if (!relationship) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const plans = await WorkoutPlan.find({ coachId: req.coach._id, assignedTo: req.params.id })
      .sort({ updatedAt: -1 })
      .lean();

    if (!plans.length) {
      return res.json({ success: true, data: [] });
    }

    const progressDocs = await WorkoutPlanProgress.find({
      planId: { $in: plans.map((p) => p._id) },
      memberId: req.params.id,
    }).lean();
    const progressByPlan = new Map(progressDocs.map((doc) => [doc.planId.toString(), doc]));

    const data = plans.map((plan) => {
      const progress = progressByPlan.get(plan._id.toString());
      const entriesByComponent = new Map((progress?.entries || []).map((e) => [e.componentId.toString(), e]));
      return {
        _id: plan._id,
        name: plan.name,
        type: plan.type,
        duration: plan.duration,
        description: plan.description,
        components: (plan.components || []).map((c) => {
          const entry = entriesByComponent.get(c._id.toString());
          return {
            _id: c._id,
            name: c.name,
            sets: c.sets,
            reps: c.reps,
            done: entry?.done || false,
            notes: entry?.notes || '',
          };
        }),
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// Mirrors userController.viewMedicalDocument's signed-URL pattern, just
// re-scoped to "this coach's own accepted client" instead of "the
// logged-in member's own document" — reuses the same
// buildMedicalDocumentResponse helper so both stay in sync, and
// re-checks the coach-client relationship independently of
// getClientDetail (this is its own request; nothing from an earlier
// request is trusted).
const getClientMedicalDocument = async (req, res, next) => {
  try {
    const relationship = await assertAcceptedClient(req.coach._id, req.params.id);
    if (!relationship) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const client = await User.findOne({ _id: req.params.id, role: 'user' }).select('medicalDocuments');
    const document = client?.medicalDocuments?.id(req.params.docId);
    const result = buildMedicalDocumentResponse(document);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const acceptRequest = async (req, res, next) => {
  try {
    const request = await CoachRegistrationRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Registration request not found' });

    // Rule #5: a coach can only accept/reject their OWN requests — not
    // just filtered out of the list, actively rejected here even if
    // someone guesses another coach's request id.
    if (request.coachId.toString() !== req.coach._id.toString()) {
      return res.status(403).json({ success: false, message: 'You are not authorized to review this request' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: `This request has already been ${request.status}` });
    }

    request.status = 'accepted';
    request.reviewedAt = new Date();
    await request.save();

    socketUtil.emitToUser(request.clientId, 'coach-request:updated', {
      requestId: request._id,
      status: 'accepted',
    });

    res.json({ success: true, message: 'Client accepted', data: request });
  } catch (error) {
    next(error);
  }
};

const rejectRequest = async (req, res, next) => {
  try {
    const request = await CoachRegistrationRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Registration request not found' });

    if (request.coachId.toString() !== req.coach._id.toString()) {
      return res.status(403).json({ success: false, message: 'You are not authorized to review this request' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: `This request has already been ${request.status}` });
    }

    request.status = 'rejected';
    request.reviewedAt = new Date();
    await request.save();

    socketUtil.emitToUser(request.clientId, 'coach-request:updated', {
      requestId: request._id,
      status: 'rejected',
    });

    res.json({ success: true, message: 'Request rejected', data: request });
  } catch (error) {
    next(error);
  }
};

// ---- Notifications (coach bell — Section 12) ----
// Unlike adminController.getNotifications (a single shared inbox every
// admin sees, unscoped), these MUST filter on recipientId — a coach must
// never see another coach's notifications just because the query forgot
// to scope it (Section 19).
const getMyNotifications = async (req, res, next) => {
  try {
    const notifications = await Notification.find({ recipientId: req.coach._id })
      .sort({ createdAt: -1 })
      .limit(30);
    const unreadCount = await Notification.countDocuments({ recipientId: req.coach._id, read: false });
    res.json({ success: true, data: notifications, unreadCount });
  } catch (error) {
    next(error);
  }
};

const markNotificationRead = async (req, res, next) => {
  try {
    // Scoped to recipientId in the filter itself (not just looked up by
    // id then trusted) — a coach guessing/enumerating another coach's
    // notification id gets the same 404 as a nonexistent one, never a
    // 403 that would confirm the id belongs to someone else.
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: req.coach._id },
      { read: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });
    socketUtil.emitToUser(req.coach._id, 'notification:read', { _id: notification._id });
    res.json({ success: true, data: notification });
  } catch (error) {
    next(error);
  }
};

const markAllNotificationsRead = async (req, res, next) => {
  try {
    await Notification.updateMany({ recipientId: req.coach._id, read: false }, { read: true });
    socketUtil.emitToUser(req.coach._id, 'notification:all-read', {});
    res.json({ success: true, message: 'All notifications marked read' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyClasses,
  getMyClassRoster,
  getMyProfile,
  updateMyProfile,
  uploadMyProfilePhoto,
  getMySettings,
  sendNotificationEmailOtp,
  updateMySettings,
  sendMyPasswordChangeOtp,
  changeMyPassword,
  getMyRequests,
  getMyClients,
  getClientDetail,
  getClientWorkout,
  getClientMedicalDocument,
  acceptRequest,
  rejectRequest,
  getMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};