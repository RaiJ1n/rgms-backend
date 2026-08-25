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
  password: { type: String, 
    required: true, 
    minlength: 8 },
  role: { type: String, 
    enum: ['user', 'admin', 'coach'], 
    default: 'user' },

  isActive: { type: Boolean, default: true },

  studentPromoActive: { type: Boolean, default: false },

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
  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);