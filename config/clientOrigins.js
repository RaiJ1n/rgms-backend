const configuredOrigins = (process.env.CLIENT_URL || '')
  .split(/\s*(?:\|\||,)\s*/)
  .map((origin) => origin.trim())
  .filter(Boolean);

module.exports = [...new Set([
  ...configuredOrigins,
  'http://localhost:5173',
  'http://localhost:5175',
])];
