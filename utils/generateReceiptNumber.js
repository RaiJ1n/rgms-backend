const { formatLocalDateLabel } = require('./localDate');

// A short, human-readable, sufficiently-unique receipt/transaction number
function generateReceiptNumber() {
  // The date part is the gym's calendar day
  const label = formatLocalDateLabel(new Date());
  const yy = label.slice(2, 4);
  const mm = label.slice(5, 7);
  const dd = label.slice(8, 10);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RGMS-${yy}${mm}${dd}-${random}`;
}

module.exports = generateReceiptNumber;