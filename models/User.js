const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  fullname: { type: String, 
    required: true, 
    trim: true },
  email: { type: String, 
    required: true, 
    unique: true, 
    lowercase: true, 
    trim: true },
  // Not required at the schema level anymore: a user who signs up via
  // Google/Facebook only (see AuthAccount.js) never sets a password at
  // all. Email/password registration still goes through the same
  // register() validator in authRoutes.js, which enforces the 8-char
  // minimum itself before this ever reaches the model — so nothing
  // changes for that flow. matchPassword() below guards the
  // OAuth-only case (no password on the document) explicitly.
  password: { type: String,
    minlength: 8 },
  role: { type: String, 
    enum: ['user', 'admin', 'coach'], 
    default: 'user' },

  isActive: { type: Boolean, default: true },

  // Section D1: one-time, global Privacy Act acknowledgment — NOT the
  // same as medicalConsentGiven below, which is a separate, narrower,
  // per-category consent that already existed for the free-text medical
  // fields specifically. This flag gates every OTHER sensitive
  // submission point (signup, profile edits, medical document upload,
  // coach registration questionnaire, student ID upload) and, once
  // true, is never asked again — set at signup for new accounts, or via
  // PUT /users/privacy-notice/acknowledge the first time an existing
  // account (created before this field existed) hits any of those
  // actions. Every gated controller checks this server-side; the
  // frontend modal is not itself what enforces anything.
  privacyNoticeAcknowledged: { type: Boolean, default: false },
  privacyNoticeAcknowledgedAt: { type: Date },

  // Bumped on every logout (and on password reset) so a JWT issued
  // before that point stops being accepted, even though it hasn't
  // expired yet. Every JWT carries the tokenVersion it was minted
  // with (see generateToken calls in authService.js); authMiddleware
  // and coachAuthMiddleware reject a token whose tokenVersion doesn't
  // match the current value on the User document. Not touched on
  // login — logging in re-uses whatever version is already current so
  // a fresh login on another device/tab doesn't invalidate this one.
  tokenVersion: { type: Number, default: 0 },

  // Coach-only fields. Only ever set/read when role === 'coach' — a
  // regular member/admin document just leaves these at their defaults.
  // Kept on User (not a separate collection) so that Coach accounts are
  // ordinary User documents like everything else the unified
  // POST /auth/login already authenticates against.
  specialization: { type: String, trim: true },
  // Who created this coach account — always the admin who created it,
  // never the coach themself (mirrors createMember's admin-only flow).
  // Section J: "Prevent unauthorized users from assigning themselves as
  // instructors."
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  studentPromoActive: { type: Boolean, default: false },

  // --- Coach Management / Client-Coach Registration System ---
  // More coach-only fields, following the exact same convention as
  // `specialization` above: plain fields on the shared User document,
  // only ever set/read when role === 'coach'. Kept here rather than a
  // separate Coach/CoachProfile collection for the same reason
  // `specialization` is — see the big comment at the top of this
  // schema. `age`, `phone` (contact number), `address`, and `photo`
  // (profile picture) already exist above and are reused as-is for a
  // coach's public profile, rather than duplicating them under new
  // names.
  sex: { type: String, enum: ['Male', 'Female', 'Other'], trim: true },
  occupation: { type: String, trim: true },
  fitnessJourney: { type: String, trim: true },
  currentFitnessGoal: { type: String, trim: true },
  preferredExerciseTime: { type: String, trim: true },
  // Settings-page-only field (Section 1, coach Settings) — separate from
  // the coach's login `email` above. This is purely where the coach
  // wants notification mail (client requests, etc.) delivered; it is
  // NEVER used for authentication, and changing it never touches the
  // login email. Empty string means "not set" — falls back to the
  // coach's login email wherever notifications are sent, same
  // empty-string convention as facebookUrl/instagramUrl below.
  // Group 8 added an email-ownership check before a new value can be
  // saved here (see the OTP fields immediately below) — the coach must
  // prove they can read mail at the new address before it's accepted,
  // the same way a real email-change flow would.
  notificationEmail: { type: String, trim: true, lowercase: true, default: '' },
  // Notification-email verification OTP (Coach Settings -> Notification,
  // Group 8). Deliberately separate from passwordChangeOtp* above: that
  // one verifies the coach still controls their EXISTING account email;
  // this one verifies they control a NEW, not-yet-saved candidate
  // address, so it needs somewhere to hold that candidate until the
  // code is confirmed. Same hash-then-store convention — only the
  // sha256 hash of the code is ever persisted.
  notificationEmailOtp: String,
  notificationEmailOtpExpires: Date,
  notificationEmailOtpLastSentAt: Date,
  // The address the pending code was actually sent to. Verifying only
  // succeeds while the form's current value still matches this — if the
  // coach edits the email again after requesting a code, the old code
  // can't be used to verify the new, unsent-to address.
  notificationEmailPendingValue: String,
  // Set true once that pending value has been confirmed via OTP; cleared
  // back to false the moment the coach edits the email again, so a
  // previously-verified address can't be silently swapped for an
  // unverified one without re-verifying.
  notificationEmailVerified: { type: Boolean, default: false },
  // Admin-controlled public visibility — whether this coach shows up on
  // the Client/User "Coaches" page. Defaults to true (visible) so a
  // freshly admin-created coach account is bookable right away without
  // an extra manual step — an admin already went through the deliberate
  // act of creating the account via coachController.createCoach, which
  // is the review gate. Admin can still hide a specific coach via
  // PUT /admin/coaches/:id/visibility (coachController.setCoachVisibility)
  // — never settable by the coach themselves.
  isDisplayed: { type: Boolean, default: true },

  phone: { type: String, 
    trim: true },
  address: { type: String,
    trim: true },

  // Member-provided social links (Admin Profile > Social Accounts).
  // Simple URL strings the member pastes in themselves — not OAuth.
  // Empty string means "not connected", same convention used to derive
  // socialAccounts.connected on the frontend.
  facebookUrl: { type: String, trim: true, default: '' },
  instagramUrl: { type: String, trim: true, default: '' },

  // Body stats — self-reported, shown on the member Dashboard/Profile.
  // All optional: a brand-new user won't have these set yet.
  age: { type: Number, min: 0, max: 120 },
  heightCm: { type: Number, min: 0 },
  weightKg: { type: Number, min: 0 },
  calorieGoal: { type: Number, min: 0 },
  birthDate: { type: Date },
  // Profile photo stored in Cloudinary: url and public_id
  photo: {
    url: { type: String },
    public_id: { type: String },
  },

  // --- Medical history (Section H) ---
  // Deliberately kept to what's needed for class/fitness-program
  // customization, not a general health record — conditions, allergies,
  // and an emergency contact are the fields an instructor would actually
  // need to safely tailor a class or workout. Never returned by
  // getMembers (the admin list view) — only by getMember (single-member
  // detail, admin-only) and the member's own profile. See
  // userController.updateProfile and adminController.getMember/
  // updateMember for the access-control side of this.
  medicalConditions: { type: String, trim: true },
  medicalAllergies: { type: String, trim: true },
  emergencyContactName: { type: String, trim: true },
  emergencyContactPhone: { type: String, trim: true },
  medicalNotes: { type: String, trim: true },

  // Required before any of the fields above are ever saved for the
  // first time — see userController.updateProfile's enforcement. Once
  // given, this stays true; medicalConsentDate records when consent was
  // first given, not re-stamped on every later edit.
  medicalConsentGiven: { type: Boolean, default: false },
  medicalConsentDate: { type: Date },

  // --- Medical document upload (Bento redesign, now multi-file) ---
  // An array of uploaded files (images or PDFs) — medical certificates,
  // clearances, doctor's notes — distinct from the free-text medical
  // fields above. Each is stored as an `authenticated` Cloudinary
  // resource (see uploadMiddleware.js's uploadMedicalDocument) so
  // `url`/`public_id` alone are not enough to fetch the file; viewing
  // always goes through userController.viewMedicalDocument, which
  // checks ownership and mints a short-lived signed URL for one
  // specific document (identified by its own _id, auto-assigned by
  // Mongoose to each array entry). Uploading is additive — a new batch
  // is appended to this array, never replacing what's already here;
  // removing one is done by _id via deleteMedicalDocument, which only
  // ever touches the single matching entry.
  medicalDocuments: [
    {
      url: { type: String },
      public_id: { type: String },
      resourceType: { type: String }, // Cloudinary resource_type used at upload time (needed to sign/delete correctly)
      fileName: { type: String },
      fileType: { type: String }, // MIME type, e.g. 'application/pdf', 'image/png'
      fileSize: { type: Number }, // bytes
      uploadedAt: { type: Date },
    },
  ],

  // Forgot-password OTP (unauthenticated flow, started from the Login
  // page's "Forgot Password" link). Same hash-then-store convention as
  // passwordChangeOtp below — only the sha256 hash is ever persisted,
  // the raw 6-digit code is emailed once and never written to the
  // database. Kept separate from passwordChangeOtp/passwordChangeOtpExpires
  // since that field belongs to the authenticated Admin Settings "Send
  // Code" flow and shouldn't be conflated with this one (same reasoning
  // as the comment on that field below).
  forgotPasswordOtp: String,
  forgotPasswordOtpExpires: Date,

  // Email verification
  isVerified: { type: Boolean, default: false },
  verificationToken: String,
  verificationTokenExpires: Date,

  // Password-change OTP (Admin Settings "Send Code"/"Resend" flow).
  // Same hashing convention as resetPasswordToken/verificationToken above:
  // only the sha256 hash is ever stored, the raw 6-digit code is emailed
  // and never persisted. Kept separate from resetPasswordToken/Expires —
  // those are for the "forgot password" flow (unauthenticated, link-based)
  // and shouldn't be conflated with this authenticated, OTP-based one.
  passwordChangeOtp: String,
  passwordChangeOtpExpires: Date,
  // Server-side cooldown anchor for "Send Code"/"Resend" — enforced in
  // adminService.js regardless of whether the frontend's own button
  // state/timer is bypassed.
  passwordChangeOtpLastSentAt: Date,

  // Read by AdminSettings.vue's "Last password change" activity summary.
  lastPasswordChange: Date,
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  // A Google/Facebook-only account has no password set at all — treat
  // any password-login attempt against it as a non-match rather than
  // letting bcrypt.compare throw on an undefined hash. The user should
  // use "Continue with Google/Facebook" instead, or set a password via
  // account settings first.
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// True once this user has a usable email/password login in addition
// to (or instead of) any linked OAuth providers. Read by
// userController/Settings if you want to show "Set a password" vs.
// "Change password" in the UI for OAuth-only accounts.
userSchema.methods.hasPassword = function () {
  return !!this.password;
};

module.exports = mongoose.model('User', userSchema);