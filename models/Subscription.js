const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true },

  planId: { type: mongoose.Schema.Types.ObjectId,
    ref: 'MembershipPlan', 
    required: true },

  // Unique
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

  // Membership/session deduction (Group 3, Section "Membership Session Deduction")
  sessionsUsed: { type: Number, default: 0 },

  // Manila 'YYYY-MM-DD' of the last day a session was deducted
  // Written in the SAME atomic update that increments sessionsUsed (subscriptionService. recordAttendanceSession)
  lastDeductedDayKey: { type: String },

}, { timestamps: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);