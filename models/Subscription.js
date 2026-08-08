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

}, { timestamps: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);