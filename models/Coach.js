const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// A Coach is a distinct account type from User — not a role on the User
// model — the same way Admin auth is kept separate. This means a coach's
// JWT can never be replayed against member/admin-protected routes (it
// won't resolve against the User collection at all), and vice versa.
const coachSchema = new mongoose.Schema({
  fullname: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8 },
  specialization: { type: String, trim: true },

  // Mirrors User.isActive — lets an admin deactivate a coach (Section J:
  // "Admin can deactivate employees") without deleting their history of
  // assigned classes/clients.
  isActive: { type: Boolean, default: true },

  // Who created this account — always an admin, never the coach
  // themself. Section J: "Prevent unauthorized users from assigning
  // themselves as instructors."
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

coachSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

coachSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('Coach', coachSchema);