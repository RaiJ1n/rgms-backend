// utils/scanConfig.js
//
// Tunables for RFID tap handling. Read from the environment on every access
// (not cached at require time) so they can be changed in .env and in tests
// without re-requiring modules.
//
//   RFID_DEBOUNCE_MS          default 5000   (0 disables)
//     Per-card duplicate-tap window. A reader that is still seeing the card
//     keeps re-sending its UID; every such repeat ARRIVING WITHIN this window
//     of the previous signal for the same card is the same tap and is ignored -
//     and each repeat pushes the window forward, so a card resting on the
//     reader for 10 s is still ONE tap. A new tap is a signal that arrives
//     after the card has been quiet for the window (card lifted, presented
//     again). It is per card: it never delays a different member's tap, and it
//     is NOT a daily limit - the same member can tap again once it has passed.
//     The Arduino sketch enforces the same 5 s before it ever sends a read;
//     this is the backend's own, authoritative copy of that rule.
//
//   RFID_DEBOUNCE_SKEW_MS     default 300    (0 disables, max 2000)
//     Timing allowance for the gap between the reader's 5 s and what the server
//     measures (serial + bridge + HTTPS latency differ tap to tap). Without it a
//     legitimate tap made right at 5.0 s could reach the server a few ms
//     "early" and be rejected as a duplicate. The server treats two signals as
//     the same tap only when they are closer than (window - skew), i.e. 4.7 s
//     by default. Capped at 10% of the window so a short test window stays
//     meaningful. Set 0 for an exact 5 s server window.
//
//   RFID_SCAN_RESULT_TTL_MS   default 120000
//     How long the server remembers the result of a scanId so a retried
//     request (bridge timeout / dropped response) gets the original answer.
const int = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

module.exports = {
  get debounceMs() { return int('RFID_DEBOUNCE_MS', 5000, 0, 30000); },
  get debounceSkewMs() { return int('RFID_DEBOUNCE_SKEW_MS', 300, 0, 2000); },
  // The window the server actually compares against: window minus the timing
  // allowance (see above). 0 when the filter is disabled.
  get effectiveDebounceMs() {
    const w = this.debounceMs;
    if (w <= 0) return 0;
    return w - Math.min(this.debounceSkewMs, Math.floor(w / 10));
  },
  get scanResultTtlMs() { return int('RFID_SCAN_RESULT_TTL_MS', 120000, 1000, 3600000); },
};