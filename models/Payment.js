const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, 
     ref: 'User', 
    required: true },

  referenceNumber: { type: String, 
     required: true, 
      trim: true },

  paymentMethod: { type: String, 
      default: 'GCash' },

  screenshot: { type: String },

  amount: { type: Number, 
    required: true },

  status: { type: String, 
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending' },

}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
