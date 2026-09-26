// utils/normalizeUid.js
//
// Single shared UID normalizer — the ONE function every RFID code path
// (serial listener, attendance lookup, card registration, reassign,
// deactivate) must use. Having two diverging normalizers (one in the
// bind path, one in the attendance path) is exactly how an already-bound
// card can show "Unknown card" during normal scans while binding works.
//
// What it handles:
//   - surrounding whitespace / newlines from the serial parser
//   - lowercase hex ("419a4e16" → "419A4E16")
//   - spaced / colon / dash separated bytes ("41 9A 4E 16",
//     "41:9A:4E:16", "41-9A-4E-16" → "419A4E16")
//   - "UID:" prefixes some sketches send ("UID: 419A4E16")
//   - "0x" prefixes
//
// Usage:
//   const { normalizeUid, isValidUid } = require('../utils/normalizeUid');
//   const uid = normalizeUid(raw);
//   if (!isValidUid(uid)) { /* READ ERROR / TRY AGAIN */ }

function normalizeUid(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim().toUpperCase();
  if (!s) return '';
  // Strip a leading "UID:" label if the sketch sends one.
  s = s.replace(/^UID\s*:\s*/, '');
  // Strip a leading 0X.
  s = s.replace(/^0X/, '');
  // Remove all common byte separators: spaces, colons, dashes,
  // underscores, commas, semicolons.
  s = s.replace(/[\s:\-_,;]+/g, '');
  return s;
}

// MIFARE Classic: 4-byte UID = 8 hex chars, 7-byte UID = 14 hex chars.
function isValidUid(uid) {
  return /^[0-9A-F]{8,14}$/.test(uid || '');
}

module.exports = { normalizeUid, isValidUid };