// The physical RFID reader isn't a logged-in user, so it can't carry a
// member/admin JWT the way `protect` expects. It authenticates instead
// with a single shared secret sent in the X-Device-Key header, checked
// against RFID_DEVICE_KEY in the environment.
//
// Set RFID_DEVICE_KEY in .env and configure the reader (or whatever
// service relays its scans to this API) to send that value on every
// request to /api/rfid/scan.
const requireDeviceKey = (req, res, next) => {
  const key = req.headers['x-device-key'];

  if (!process.env.RFID_DEVICE_KEY) {
    return res.status(500).json({
      success: false,
      message: 'Server misconfigured: RFID_DEVICE_KEY is not set',
    });
  }

  if (!key || key !== process.env.RFID_DEVICE_KEY) {
    return res.status(401).json({ success: false, message: 'Invalid or missing device key' });
  }

  next();
};

module.exports = { requireDeviceKey };