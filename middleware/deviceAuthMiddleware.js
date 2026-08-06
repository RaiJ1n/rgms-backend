
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