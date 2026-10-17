// utils/normalizeUid.js
// utils/normalizeUid.js Single shared UID normalizer — the ONE function every RFID code path

function normalizeUid(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim().toUpperCase();
  if (!s) return '';
  s = s.replace(/^UID\s*:\s*/, '');
  // Strip a leading 0X
  s = s.replace(/^0X/, '');
  s = s.replace(/[\s:\-_,;]+/g, '');
  return s;
}

// MIFARE Classic
function isValidUid(uid) {
  return /^[0-9A-F]{8,14}$/.test(uid || '');
}

module.exports = { normalizeUid, isValidUid };