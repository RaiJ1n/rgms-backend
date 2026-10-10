// services/scanDedup.js
//
// Request-level idempotency for POST /rfid/scan, keyed by the bridge's scanId.
//
//   * Same scanId while the first request is still running -> the second
//     caller waits for and shares that one result (no second execution).
//   * Same scanId after it finished (a retry because the response was lost)
//     -> the original result is returned, flagged `replayed`.
//
// Only completed outcomes ({status, body}, including business denials) are
// remembered. An unexpected failure (thrown error) is NOT cached, so a retry
// can really try again; the database-level request ids still make that retry
// safe for member attendance.
//
// In-memory and per-process by design: it is the fast path. The durable path
// is Attendance.requestId / checkOutRequestId (see attendanceService).
const scanConfig = require('../utils/scanConfig');

const inflight = new Map();
const recent = new Map(); // key -> { value, at }
const MAX_ENTRIES = 1000;

function prune(now) {
  const ttl = scanConfig.scanResultTtlMs;
  for (const [k, v] of recent) {
    if (now - v.at > ttl) recent.delete(k);
    else break; // Map keeps insertion order => the rest are newer
  }
  while (recent.size > MAX_ENTRIES) recent.delete(recent.keys().next().value);
}

async function once(key, fn) {
  if (!key) return fn();
  const now = Date.now();
  prune(now);
  const hit = recent.get(key);
  if (hit) return { status: hit.value.status, body: { ...hit.value.body, replayed: true } };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const value = await fn();
    recent.set(key, { value, at: Date.now() });
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function _reset() { inflight.clear(); recent.clear(); }

module.exports = { once, _reset };
