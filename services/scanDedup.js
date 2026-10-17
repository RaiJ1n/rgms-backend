// services/scanDedup.js
// services/scanDedup.js Request-level idempotency for POST /rfid/scan, keyed by the bridge's scanId. * Same scanId
const scanConfig = require('../utils/scanConfig');

const inflight = new Map();
const recent = new Map();
const MAX_ENTRIES = 1000;

function prune(now) {
  const ttl = scanConfig.scanResultTtlMs;
  for (const [k, v] of recent) {
    if (now - v.at > ttl) recent.delete(k);
    else break;
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
