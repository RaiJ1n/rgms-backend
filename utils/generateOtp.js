const crypto = require('crypto');

// 6-digit numeric OTP for the Admin Settings "Send Code" / "Resend"
// password-change flow. Same hash-then-store convention as
// generateResetToken.js / generateVerificationToken.js: only the sha256
// hash is ever persisted (see User.js's passwordChangeOtp field) — the
// raw code is emailed once and never written to the database.
const generateOtp = () => {
  // randomInt is cryptographically secure and avoids the modulo bias
  // Math.random()-based approaches have.
  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');
  return { otp, hashedOtp };
};

const hashOtp = (otp) => {
  return crypto.createHash('sha256').update(otp).digest('hex');
};

module.exports = { generateOtp, hashOtp };