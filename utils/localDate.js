// "Today" for attendance/RFID purposes always means the gym's local day
// (Asia/Manila, UTC+8, no DST) — never whatever timezone the server
// process happens to be running in. `new Date(); setHours(0,0,0,0)`
// looks correct in dev (where the machine's local TZ usually matches)
// but silently breaks if this ever deploys to a host/container set to
// UTC or any other zone: attendance taken late at night could get
// bucketed into the wrong calendar day. Doing the offset math directly
// means "today" means the same thing regardless of server configuration.
const MANILA_UTC_OFFSET_MINUTES = 8 * 60;

/**
 * Returns a real UTC Date instant representing 00:00:00.000 of the given
 * date's Manila-local day. Safe to compare directly against Mongo
 * `createdAt` timestamps (which are always stored as UTC instants).
 */
function startOfLocalDay(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

/**
 * End-of-day counterpart — 23:59:59.999 of the given date's Manila-local
 * day, as a real UTC instant. Just under 24h after startOfLocalDay.
 */
function endOfLocalDay(date = new Date()) {
  return new Date(startOfLocalDay(date).getTime() + 24 * 60 * 60 * 1000 - 1);
}

/**
 * Start of the Manila-local ISO week (Monday 00:00:00.000) containing the
 * given date, as a real UTC instant. Uses the same "shift, do wall-clock
 * math in UTC fields, shift back" approach as startOfLocalDay — never the
 * server/browser's own timezone.
 */
function startOfLocalWeek(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  const day = shifted.getUTCDay(); // 0=Sun..6=Sat, read as Manila-local wall-clock day
  const daysSinceMonday = (day + 6) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - daysSinceMonday);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Start of the Manila-local calendar month containing the given date.
 */
function startOfLocalMonth(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Start of the Manila-local calendar year containing the given date.
 */
function startOfLocalYear(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCMonth(0, 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

/**
 * 'YYYY-MM-DD' for the given instant's Manila-local calendar date.
 * NOT the same as `date.toISOString().split('T')[0]` — that converts
 * back to UTC first, which for a UTC+8 zone mislabels anything from
 * midnight to 7:59am Manila time as the previous day.
 */
function formatLocalDateLabel(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().split('T')[0];
}

module.exports = {
  startOfLocalDay,
  endOfLocalDay,
  startOfLocalWeek,
  startOfLocalMonth,
  startOfLocalYear,
  formatLocalDateLabel,
};