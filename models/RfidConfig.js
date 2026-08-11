const mongoose = require('mongoose');

// Singleton-style config document (there should only ever be one row).
// Persists the admin's chosen RFID scanner port + baud rate, plus enough
// USB metadata (vendor/product/serial) to re-identify the *same physical
// device* on next startup even if Windows assigns it a different COM
// number after a reconnect. See rfidService.js's portMatchesConfig() —
// that's what actually uses these fields to decide whether a currently
// listed port is "the same Arduino we connected to before" rather than
// blindly trusting a saved COM string.
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