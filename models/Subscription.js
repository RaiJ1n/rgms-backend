const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true },

  planId: { type: mongoose.Schema.Types.ObjectId,
    ref: 'MembershipPlan', 
    required: true },

  // unique: true closes the race that a plain findOne-then-create check
  // can't — if createSubscription is ever invoked twice for the same
  // payment (double-click, retry, etc.), the second insert fails at the
  // database level instead of silently creating a second extension.
  paymentId: { type: mongoose.Schema.Types.ObjectId, 
    ref: 'Payment', 
    required: true,
    unique: true },

  startDate: { type: Date, 
    required: true },

  endDate: { type: Date, 
    required: true },

  status: { type: String, 
    enum: ['active', 'inactive', 'expired'], 
    default: 'inactive' },

  // Membership/session deduction (Group 3, Section "Membership Session
  // Deduction"): incremented by subscriptionService.recordAttendanceSession
  // whenever the member is granted gym access via an RFID tap or a
  // manually-recorded attendance entry — never for a Day Pass plan (a
  // 1-day/1-session plan has nothing meaningful left to track after its
  // single visit). The *total* sessions a plan grants is derived from
  // the subscription's own day span (endDate - startDate in days) —
  // the same figure Dashboard.vue already computes for its "X/Y days"
  // progress bar — rather than a separate stored field, so there's only
  // one place (the date range) that defines how long/how many visits a
  // plan is worth.
  sessionsUsed: { type: Number, default: 0 },

}, { timestamps: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);