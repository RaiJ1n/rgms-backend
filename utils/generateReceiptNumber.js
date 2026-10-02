const { formatLocalDateLabel } = require('./localDate');

// A short, human-readable, sufficiently-unique receipt/transaction number.
// Format: RGMS-<YYMMDD>-<6 random base36 chars> — e.g. RGMS-260819-K3F9QX.
// Not cryptographically unique (no DB round-trip to guarantee it), but the
// date prefix plus 6 random chars (36^6 ≈ 2.2 billion combinations per day)
// makes an accidental collision on the same day negligible for a single
// gym's transaction volume. Payment.transactionNumber still has a unique
// index (see models/Payment.js) as the actual backstop — a collision would
// surface as a save() error to retry, not a silent duplicate.
function generateReceiptNumber() {
  // The date part is the gym's calendar day (Asia/Manila). getFullYear()/
  // getMonth()/getDate() use the SERVER's timezone, so on a UTC VPS a payment
  // taken at 7am Manila time was numbered with yesterday's date.
  const label = formatLocalDateLabel(new Date()); // YYYY-MM-DD, Manila
  const yy = label.slice(2, 4);
  const mm = label.slice(5, 7);
  const dd = label.slice(8, 10);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RGMS-${yy}${mm}${dd}-${random}`;
}

module.exports = generateReceiptNumber;