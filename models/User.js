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
    enum: ['user', 'admin'], 
    default: 'user' },

  isActive: { type: Boolean, default: true },

  studentPromoActive: { type: Boolean, default: false },

  phone: { type: String, 
    trim: true },
  address: { type: String,
    trim: true },

  // Body stats — self-reported, shown on the member Dashboard/Profile.
  // All optional: a brand-new user won't have these set yet.
  age: { type: Number, min: 0, max: 120 },
  heightCm: { type: Number, min: 0 },
  weightKg: { type: Number, min: 0 },
  calorieGoal: { type: Number, min: 0 },
  birthDate: { type: Date },

  resetPasswordToken: String,
  resetPasswordExpires: Date,

  // Email verification
  isVerified: { type: Boolean, default: false },
  verificationToken: String,
  verificationTokenExpires: Date,
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