const mongoose = require('mongoose');

// Ensure the base User model is registered first
const User = require('./User');

// Create a small admin schema that enforces the `role` field
const adminSchema = new mongoose.Schema({}, { timestamps: true });

adminSchema.pre('save', function (next) {
  if (this.role !== 'admin') this.role = 'admin';
  next();
});

// Create a discriminator model so admins are stored alongside users
const Admin = mongoose.model('User').discriminator('Admin', adminSchema);

module.exports = Admin;
