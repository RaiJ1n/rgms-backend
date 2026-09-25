// utils/normalizeUid.js
//
// Single canonical UID normalization for the entire RFID chain.
//
// Canonical form: UPPERCASE hex with NO separators, e.g. "A1B2C3D4".
// - UIDs are ALWAYS strings (never numbers — leading zeros matter).
// - Accepts: "A1 B2 C3 D4", "A1B2C3D4", "a1b2c3d4", "A1-B2-C3-D4",
//   "A1:B2:C3:D4", plus trailing "\r\n" / whitespace from Serial.
// - Strips: whitespace, hyphens, colons, then uppercases.
// - Does NOT strip anything else, so meaningful hex is never lost.

function normalizeUid(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().replace(/[\s\-:]/g, '').toUpperCase();
}

function isValidUid(uid) {
  return /^[0-9A-F]{8,14}$/.test(uid);
}

module.exports = { normalizeUid, isValidUid };
