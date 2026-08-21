// A short, human-readable, sufficiently-unique receipt/transaction number.
// Format: RGMS-<YYMMDD>-<6 random base36 chars> — e.g. RGMS-260819-K3F9QX.
// Not cryptographically unique (no DB round-trip to guarantee it), but the
// date prefix plus 6 random chars (36^6 ≈ 2.2 billion combinations per day)
// makes an accidental collision on the same day negligible for a single
// gym's transaction volume. Payment.transactionNumber still has a unique
// index (see models/Payment.js) as the actual backstop — a collision would
// surface as a save() error to retry, not a silent duplicate.
function generateReceiptNumber() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RGMS-${yy}${mm}${dd}-${random}`;
}

module.exports = generateReceiptNumber;