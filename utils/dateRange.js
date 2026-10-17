// utils/dateRange.js
// utils/dateRange.js One place that turns user-supplied dates into real instants, always in the gym's own timezone
const { startOfLocalDay, endOfLocalDay, formatLocalDateLabel } = require('./localDate');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' -> Manila start-of-day instant, or null if not a REAL date
function parseDay(str) {
  if (typeof str !== 'string' || !DAY_RE.test(str.trim())) return null;
  const d = new Date(`${str.trim()}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return formatLocalDateLabel(d) === str.trim() ? startOfLocalDay(d) : null;
}

// Inclusive Manila-day range for reports, history filters and exports
// Past, current and future dates are all valid here (reports must reach into history); the only rules are: real dates
function parseRange(startStr, endStr) {
  const out = { ok: true };
  if (startStr) {
    const s = parseDay(String(startStr));
    if (!s) return { ok: false, message: 'Start date is not a valid date (use YYYY-MM-DD).' };
    out.start = s;
  }
  if (endStr) {
    const e = parseDay(String(endStr));
    if (!e) return { ok: false, message: 'End date is not a valid date (use YYYY-MM-DD).' };
    out.end = endOfLocalDay(e);
  }
  if (out.start && out.end && out.start > out.end) {
    return { ok: false, message: 'Start date cannot be later than end date.' };
  }
  return out;
}

// Rule for things that GRANT something on a date (visitor pass, scheduled items): today or later
function isPastDay(str, now = new Date()) {
  const d = parseDay(String(str));
  return !!d && d < startOfLocalDay(now);
}

module.exports = { parseDay, parseRange, isPastDay };