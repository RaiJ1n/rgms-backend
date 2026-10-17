// utils/scanConfig.js
// RFID_DEBOUNCE_MS default 5000 (0 disables) Per-card duplicate-tap window
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
  // The window the server actually compares against: window minus the timing allowance (see above)
  get effectiveDebounceMs() {
    const w = this.debounceMs;
    if (w <= 0) return 0;
    return w - Math.min(this.debounceSkewMs, Math.floor(w / 10));
  },
  get scanResultTtlMs() { return int('RFID_SCAN_RESULT_TTL_MS', 120000, 1000, 3600000); },
};