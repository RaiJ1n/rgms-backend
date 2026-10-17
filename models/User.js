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
  // Not required at the schema level anymore: a user who signs up via Google/Facebook only
  password: { type: String,
    minlength: 8 },
  role: { type: String, 
    enum: ['user', 'admin', 'coach'], 
    default: 'user' },

  isActive: { type: Boolean, default: true },

  // one-time, global Privacy Act acknowledgment — NOT the same as medicalConsentGiven below
  // Section D1: one-time, global Privacy Act acknowledgment — NOT the same as medicalConsentGiven below
  privacyNoticeAcknowledged: { type: Boolean, default: false },
  privacyNoticeAcknowledgedAt: { type: Date },

  // Bumped on every logout (and on password reset)
  // Bumped on every logout (and on password reset) so a JWT issued before that point stops being accepted
  tokenVersion: { type: Number, default: 0 },

  // Coach-only fields
  specialization: { type: String, trim: true },
  // Who created this coach account — always the admin who created it, never the coach themself
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  studentPromoActive: { type: Boolean, default: false },

  sex: { type: String, enum: ['Male', 'Female', 'Other'], trim: true },
  occupation: { type: String, trim: true },
  fitnessJourney: { type: String, trim: true },
  currentFitnessGoal: { type: String, trim: true },
  preferredExerciseTime: { type: String, trim: true },
  // Settings-page-only field (Section 1, coach Settings) — separate from the coach's login `email` above
  // This is purely where the coach wants notification mail (client requests, etc.) delivered; it is NEVER
  notificationEmail: { type: String, trim: true, lowercase: true, default: '' },
  // Notification-email verification OTP (Coach Settings -> Notification, Group 8)
  // Same hash-then-store convention — only the sha256 hash of the code is ever persisted
  notificationEmailOtp: String,
  notificationEmailOtpExpires: Date,
  notificationEmailOtpLastSentAt: Date,
  notificationEmailPendingValue: String,
  // Set true once that pending value has been confirmed via OTP
  notificationEmailVerified: { type: Boolean, default: false },
  // Admin-controlled public visibility — whether this coach shows up on the Client/User "Coaches" page
  // Admin can still hide a specific coach via — never settable by the coach themselves
  isDisplayed: { type: Boolean, default: true },

  phone: { type: String, 
    trim: true },
  address: { type: String,
    trim: true },

  facebookUrl: { type: String, trim: true, default: '' },
  instagramUrl: { type: String, trim: true, default: '' },

  // Body stats
  age: { type: Number, min: 0, max: 120 },
  heightCm: { type: Number, min: 0 },
  weightKg: { type: Number, min: 0 },
  calorieGoal: { type: Number, min: 0 },
  birthDate: { type: Date },
  photo: {
    url: { type: String },
    public_id: { type: String },
  },

  // Medical history (Section H) Deliberately kept to what's needed for class/fitness-program
  // Never returned by getMembers (the admin list view) — only by getMember
  medicalConditions: { type: String, trim: true },
  medicalAllergies: { type: String, trim: true },
  emergencyContactName: { type: String, trim: true },
  emergencyContactPhone: { type: String, trim: true },
  medicalNotes: { type: String, trim: true },

  // Required before any of the fields above are ever saved for the first time
  // Once given, this stays true; medicalConsentDate records when consent was first given
  medicalConsentGiven: { type: Boolean, default: false },
  medicalConsentDate: { type: Date },

  // Medical document upload (Bento redesign, now multi-file) An array of uploaded files (images or PDFs)
  // Each is stored as an `authenticated` Cloudinary resource (see uploadMiddleware.js's uploadMedicalDocument)
  medicalDocuments: [
    {
      url: { type: String },
      public_id: { type: String },
      resourceType: { type: String },
      fileName: { type: String },
      fileType: { type: String },
      fileSize: { type: Number },
      uploadedAt: { type: Date },
    },
  ],

  // Forgot-password OTP (unauthenticated flow, started from the Login page's "Forgot Password" link)
  // Same hash-then-store convention as passwordChangeOtp below — only the sha256 hash is ever persisted
  forgotPasswordOtp: String,
  forgotPasswordOtpExpires: Date,

  // Email verification
  isVerified: { type: Boolean, default: false },
  verificationToken: String,
  verificationTokenExpires: Date,

  // Password-change OTP (Admin Settings "Send Code"/"Resend" flow)
  passwordChangeOtp: String,
  passwordChangeOtpExpires: Date,
  // Server-side cooldown anchor for "Send Code"/"Resend"
  passwordChangeOtpLastSentAt: Date,

  // Read by AdminSettings.vue's "Last password change" activity summary
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
  // A Google/Facebook-only account has no password set at all
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// True once this user has a usable email/password login in addition to
// True once this user has a usable email/password login in addition to (or instead of) any linked OAuth providers
userSchema.methods.hasPassword = function () {
  return !!this.password;
};

module.exports = mongoose.model('User', userSchema);