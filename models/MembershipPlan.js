const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: { type: String,
          required: true,
            trim: true },

  // Kept as a free-text display label ("Daily Pass", "Student Plan", etc.)
  // shown on Membership.vue and receipts. No longer used for date math —
  // see durationValue/durationUnit below.
  duration: { type: String, required: true,
              trim: true },

  // Actual expiration math is derived from these two fields instead of
  // string-matching `duration`. This is what fixes membership expiration
  // being wrong/hardcoded regardless of plan, and lets any new plan
  // (e.g. a Student Plan) work automatically without a code change in
  // subscriptionService.js.
  durationValue: { type: Number, required: true, min: 1 },
  durationUnit: {
    type: String,
    required: true,
    enum: ['day', 'week', 'month', 'year'],
  },

  price: { type: Number,
          required: true },

  // Discounted price for members with a verified student ID
  // (User.studentPromoActive). Falls back to `price` if unset.
  studentPrice: { type: Number },

  description: { type: String,
                  trim: true },

}, { timestamps: true });

module.exports = mongoose.model('MembershipPlan', planSchema);