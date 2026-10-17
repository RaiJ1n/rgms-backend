const mongoose = require('mongoose');

// Singleton-style config document (there should only ever be one row)
const rfidConfigSchema = new mongoose.Schema(
  {
    preferredPort: { type: String, default: null },
    preferredVendorId: { type: String, default: null },
    preferredProductId: { type: String, default: null },
    preferredSerialNumber: { type: String, default: null },
    baudRate: { type: Number, default: 9600 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RfidConfig', rfidConfigSchema);