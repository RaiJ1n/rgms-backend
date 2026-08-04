const crypto = require('crypto');

const generateVerificationToken = () => {
  const verificationToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');
  return { verificationToken, hashedToken };
};

const hashVerificationToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

module.exports = { generateVerificationToken, hashVerificationToken };