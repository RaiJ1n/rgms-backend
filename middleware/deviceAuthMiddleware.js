const crypto = require('crypto');

// Device (serial bridge) authentication for /api/rfid/scan, /device-status, /ping.
//
// Security is unchanged: a missing or wrong key is ALWAYS rejected with 401.
// What changed:
//   * The configured key and the header value are both trimmed. A trailing
//     space/newline pasted into the VPS .env (or the bridge env) used to make a
//     "correct" key fail the strict === compare.
//   * The compare is constant-time.
//   * The 401 carries errorCode 'device_key_invalid' | 'device_key_missing' so a
//     client can tell an authentication failure from a card-lookup failure
//     (404 card_unregistered, 403 card_deactivated, ...). The key is never
//     logged or echoed.
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();

const requireDeviceKey = (req, res, next) => {
  const expected = String(process.env.RFID_DEVICE_KEY || '').trim();

  if (!expected) {
    return res.status(500).json({
      success: false,
      errorCode: 'device_key_not_configured',
      message: 'Server misconfigured: RFID_DEVICE_KEY is not set',
    });
  }

  const provided = String(req.headers['x-device-key'] || '').trim();
  const reject = (errorCode, message) =>
    res.status(401).json({
      success: false,
      errorCode,
      message,
      lcd: { line1: 'DEVICE KEY', line2: 'REJECTED' },
    });

  if (!provided) return reject('device_key_missing', 'Invalid or missing device key');

  // Hash both sides first so timingSafeEqual always gets equal-length buffers.
  if (!crypto.timingSafeEqual(sha256(provided), sha256(expected))) {
    return reject('device_key_invalid', 'Invalid or missing device key');
  }

  next();
};

module.exports = { requireDeviceKey };
