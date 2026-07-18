const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true },

  planId: { type: mongoose.Schema.Types.ObjectId,
    ref: 'MembershipPlan', 
    required: true },

  paymentId: { type: mongoose.Schema.Types.ObjectId, 
    ref: 'Payment', 
    required: true },

  startDate: { type: Date, 
    required: true },

  endDate: { type: Date, 
    required: true },

  status: { type: String, 
    enum: ['active', 'inactive', 'expired'], 
    default: 'inactive' },

}, { timestamps: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);
