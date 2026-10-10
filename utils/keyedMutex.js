// utils/keyedMutex.js
//
// Runs async functions that share a key strictly one after another, in the
// order they were requested (FIFO). Different keys never wait on each other.
//
// Used so every attendance action for one member is applied in order inside
// this process. It is a coordination aid, NOT the safety net: correctness
// across processes (PM2 cluster, a second server) still comes from the
// database's unique "one open session per member" index and the idempotency
// keys.
const tails = new Map();

async function withKeyLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

module.exports = { withKeyLock };
