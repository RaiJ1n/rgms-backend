// utils/uidHash.js
// utils/uidHash.js Keyed hashing of RFID UIDs
const crypto = require('crypto');
const { normalizeUid } = require('./normalizeUid');

const MIN_SECRET_LENGTH = 16;
let warned = false;

function secret() {
  const s = process.env.RFID_HASH_SECRET;
  if (!s) return null;
  if (s.length < MIN_SECRET_LENGTH) {
    if (!warned) {
      warned = true;
      console.error(`[RFID] RFID_HASH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — hashing is DISABLED until it is lengthened (use 32+ random characters).`);
    }
    return null;
  }
  return s;
}

const isEnabled = () => secret() !== null;

// Domain-separated so the same secret could never produce a hash that is valid for some other purpose
// Returns null when hashing is not enabled
function hashUid(uid) {
  const key = secret();
  const normalized = normalizeUid(uid);
  if (!key || !normalized) return null;
  return crypto.createHmac('sha256', key).update(`rfid-uid-v1:${normalized}`).digest('hex');
}

// Opaque, non-reversible card reference used in place of the raw UID in lists, audit logs
// 48 bits of the hash: unique across any realistic number of cards (the unique index on cardId is the backstop)
const refFromHash = (hash) => `CARD-${hash.slice(0, 12).toUpperCase()}`;
const OPAQUE_REF = /^CARD-[0-9A-F]{12}$/;

// Fields to store on a NEW card for this UID
function identityFor(uid) {
  const normalized = normalizeUid(uid);
  const hash = hashUid(normalized);
  if (!hash) return { cardId: normalized };
  if (process.env.RFID_STORE_RAW_UID === 'true') return { cardId: normalized, uidHash: hash };
  return { cardId: refFromHash(hash), uidHash: hash };
}

// For log lines: never print a full UID once hashing is on
function logUid(uid) {
  const n = normalizeUid(uid);
  if (!isEnabled()) return n;
  return n.length > 4 ? `****${n.slice(-4)}` : '****';
}

module.exports = { isEnabled, hashUid, identityFor, refFromHash, logUid, OPAQUE_REF };