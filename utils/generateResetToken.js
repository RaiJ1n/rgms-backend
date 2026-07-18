const crypto = require('crypto');

const generateResetToken = () => {
  const resetToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  return { resetToken, hashedToken };
};

const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

module.exports = { generateResetToken, hashToken };
