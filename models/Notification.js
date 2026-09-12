const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  // 'workout_started' — Section 12: fired the first time a client
  // engages with (creates progress on) a coach-assigned workout plan.
  // Existing 'signup'/'student_id' types are untouched.
  type: { type: String, enum: ['signup', 'student_id', 'workout_started'], required: true },
  message: { type: String, required: true },
  // The user this notification is ABOUT (e.g. the member who signed up,
  // or — for workout_started — the client who started the workout).
  // Always set. Existing behavior, unchanged.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // The user this notification is FOR — who should actually see it.
  // Left unset (null) for the existing admin-bell notification types,
  // which stay visible to every admin via the shared, unscoped
  // Notification.find() in adminController.getNotifications (Section
  // 19: admin's notification model is a single shared inbox, not
  // per-admin). Set to a specific coach's _id for 'workout_started' so
  // coachController-style queries can filter strictly to
  // { recipientId: req.coach._id } — a coach must never see another
  // coach's notifications by omission of this filter.
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  studentVerificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StudentVerification' },
  // Context for 'workout_started' so the coach's bell can deep-link to
  // the right plan; unused/omitted for other types.
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkoutPlan' },
  read: { type: Boolean, default: false },
}, { timestamps: true });

// Powers the coach notification bell's "my notifications, newest first"
// query (recipientId + createdAt) without a full collection scan as
// volume grows — mirrors the implicit _id-order scan admin's unscoped
// Notification.find() already relies on, just indexed since this query
// IS filtered.
notificationSchema.index({ recipientId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);