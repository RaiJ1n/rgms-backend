const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  // Optional since walk-in (non-member) payments
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // 'MEMBER'
  // Never query { customerType: 'MEMBER' }: old documents don't have the field
  customerType: { type: String, enum: ['MEMBER', 'WALK_IN'], default: 'MEMBER' },
  customerName: { type: String, trim: true, maxlength: 60 },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'MembershipPlan' },

  // No longer required: true at the schema level
  // 
  referenceNumber: { type: String, trim: true },

  // The actual system-generated receipt/transaction number the checklist asked for
  // The actual system-generated receipt/transaction number the checklist asked for — distinct from referenceNumber
  transactionNumber: { type: String, unique: true, sparse: true, trim: true },

  paymentMethod: { type: String, default: 'GCash' },
  screenshot: { type: String },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

// Payment History filters/sorts/reports by these
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ paymentMethod: 1, createdAt: -1 });
paymentSchema.index({ customerType: 1, createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);