const { validationResult } = require('express-validator');
const GymClass = require('../models/GymClass');
const User = require('../models/User');
const CoachRegistrationRequest = require('../models/CoachRegistrationRequest');
const cloudinary = require('../config/cloudinary');
const socketUtil = require('../utils/socket');
// Shared with the member's own medical-document view (Section 4:
// "Medical Documents" on the Client Details page a coach sees) — reuses
// the exact same "mint a fresh signed URL, never persist/hand out a raw
// one" helper rather than duplicating it, same reasoning as
// adminController.getMemberMedicalDocument reusing it for the admin side.
const { buildMedicalDocumentResponse } = require('./userController');

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
      },
    });
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

    const { notificationEmail } = req.body;
    // Empty string is valid here — it's how a coach clears the override
    // and falls back to their login email for notifications.
    if (notificationEmail !== undefined) {
      coach.notificationEmail = notificationEmail.trim().toLowerCase();
    }

    await coach.save();
    res.json({
      success: true,
      message: 'Settings updated',
      data: { email: coach.email, notificationEmail: coach.notificationEmail || '' },
    });
  } catch (error) {
    next(error);
  }
};

// Same current-password-required pattern as userController's
// change-password for members — a coach proves they know the current
// password before setting a new one. Unlike Admin Settings, no OTP step
// here; that OTP flow is specific to AdminSettings.vue's own design and
// isn't part of this spec for coaches.
const changeMyPassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { currentPassword, newPassword } = req.body;

    const coach = await User.findById(req.coach._id);
    if (!coach) return res.status(404).json({ success: false, message: 'Coach not found' });

    const matches = await coach.matchPassword(currentPassword);
    if (!matches) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    coach.password = newPassword; // re-hashed by the User pre('save') hook
    coach.lastPasswordChange = new Date();
    await coach.save();

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

module.exports = {
  getMyClasses,
  getMyClassRoster,
  getMyProfile,
  updateMyProfile,
  uploadMyProfilePhoto,
  getMySettings,
  updateMySettings,
  changeMyPassword,
  getMyRequests,
  getMyClients,
  getClientDetail,
  getClientMedicalDocument,
  acceptRequest,
  rejectRequest,
};