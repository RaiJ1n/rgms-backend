const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  // Optional since walk-in (non-member) payments: a customer who pays at the
  // front desk without an account has no User. Member payments always set it
  // — enforced in the controllers (createManualPayment / submitPayment), not
  // here, the same way this codebase already handles other conditional rules.
  // Old documents all have a userId, so nothing needs migrating.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // 'MEMBER' (default — also what every pre-existing payment is) or 'WALK_IN'.
  // Never query { customerType: 'MEMBER' }: old documents don't have the
  // field. Use { $ne: 'WALK_IN' } (see services/paymentQueryService.js).
  customerType: { type: String, enum: ['MEMBER', 'WALK_IN'], default: 'MEMBER' },
  // Name given at the desk for a WALK_IN payment. Unset for member payments
  // (their name comes from the User).
  customerName: { type: String, trim: true, maxlength: 60 },
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

// Payment History filters/sorts/reports by these; without indexes each list
// call scans the whole collection as the history grows. (Index builds are
// automatic on first start; on a small gym DB they are instant.)
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ paymentMethod: 1, createdAt: -1 });
paymentSchema.index({ customerType: 1, createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);