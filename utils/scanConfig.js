// utils/scanConfig.js
//
// Tunables for RFID tap handling. Read from the environment on every access
// (not cached at require time) so they can be changed in .env and in tests
// without re-requiring modules.
//
//   RFID_DEBOUNCE_MS          default 1500   (0 disables)
//     Sliding "same physical tap" window. A reader that is still seeing the
//     card keeps re-sending its UID; every such repeat ARRIVING WITHIN this
//     many ms of the previous signal for the same card is the same tap and is
//     ignored - and each repeat pushes the window forward, so a card resting
//     on the reader for 10 s is still ONE tap. A new tap is a signal that
//     arrives after the reader has been quiet for this long (card lifted,
//     then presented again). It is NOT a cooldown between actions: tap 2 may
//     happen the moment the window has been quiet.
//     Rule of thumb: a little above the reader's repeat interval, well below
//     the quickest deliberate lift-and-retap. Measure with BRIDGE_DEBUG=1
//     (see RFID_MULTI_TAP.md).
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
  get debounceMs() { return int('RFID_DEBOUNCE_MS', 1500, 0, 30000); },
  get scanResultTtlMs() { return int('RFID_SCAN_RESULT_TTL_MS', 120000, 1000, 3600000); },
};
