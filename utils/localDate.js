// "Today" for attendance/RFID purposes always means the gym's local day (Asia/Manila, UTC+8, no DST)
const MANILA_UTC_OFFSET_MINUTES = 8 * 60;

// Returns a real UTC Date instant representing 00:00:00.000 of the given date's Manila-local day
// Safe to compare directly against Mongo `createdAt` timestamps (which are always stored as UTC instants)
function startOfLocalDay(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

// End-of-day counterpart
function endOfLocalDay(date = new Date()) {
  return new Date(startOfLocalDay(date).getTime() + 24 * 60 * 60 * 1000 - 1);
}

// Start of the Manila-local ISO week (Monday 00:00:00.000) containing the given date
// Start of the Manila-local ISO week (Monday 00:00:00.000) containing the given date, as a real UTC instant
function startOfLocalWeek(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  const day = shifted.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - daysSinceMonday);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

// Start of the Manila-local calendar month containing the given date
function startOfLocalMonth(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

// Start of the Manila-local calendar year containing the given date
function startOfLocalYear(date = new Date()) {
  const shifted = new Date(date.getTime() + MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCMonth(0, 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_UTC_OFFSET_MINUTES * 60 * 1000);
}

// 'YYYY-MM-DD' for the given instant's Manila-local calendar date
// NOT the same as `date.toISOString().split('T')[0]` — that converts back to UTC first
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