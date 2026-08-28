const crypto = require('crypto');
const generateOtp = () => {
  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');
  return { otp, hashedOtp };
};

const hashOtp = (otp) => {
  return crypto.createHash('sha256').update(otp).digest('hex');
};

module.exports = { generateOtp, hashOtp };