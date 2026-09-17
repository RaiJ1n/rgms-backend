const configuredOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(/\s*(?:\|\||,)\s*/)
  .map((origin) => origin.trim())
  .filter(Boolean);

module.exports = configuredOrigins;
