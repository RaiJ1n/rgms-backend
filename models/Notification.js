const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  type: { type: String, enum: ['signup', 'student_id', 'workout_started'], required: true },
  message: { type: String, required: true },
  // The user this notification is ABOUT
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // The user this notification is FOR — who should actually see it
  // Set to a specific coach's _id for 'workout_started'
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  studentVerificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StudentVerification' },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkoutPlan' },
  read: { type: Boolean, default: false },
}, { timestamps: true });

// Powers the coach notification bell's "my notifications, newest first" query
notificationSchema.index({ recipientId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);