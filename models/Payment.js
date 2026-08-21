const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'MembershipPlan' },

  // No longer required: true at the schema level. GCash payments still
  // require it — enforced in paymentRoutes.js's express-validator rules,
  // where a member submits their own payment — but a Walk-in/cash payment
  // recorded by an admin has no external reference number to begin with.
  // (Was previously satisfied with a MANUAL-<timestamp> placeholder in
  // this same field — see transactionNumber below for the real fix.)
  referenceNumber: { type: String, trim: true },

  // The actual system-generated receipt/transaction number the checklist
  // asked for — distinct from referenceNumber (which is the *external*
  // GCash reference the member provides). Generated for every payment,
  // member-submitted or admin-recorded, via utils/generateReceiptNumber.js.
  transactionNumber: { type: String, unique: true, sparse: true, trim: true },

  paymentMethod: { type: String, default: 'GCash' },
  screenshot: { type: String },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);