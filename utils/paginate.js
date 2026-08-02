// Shared page/limit parsing for admin list endpoints (members, payments,
// classes). Keeping this in one place means all three endpoints clamp and
// default the same way instead of drifting apart.
//
// `export=true` bypasses paging entirely (capped at EXPORT_MAX) so the
// "Export" buttons on these pages can still download every row matching
// the current search/filters, not just whatever page is on screen.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EXPORT_MAX = 5000;

function parsePagination(query) {
  const isExport = query.export === 'true' || query.export === '1';

  if (isExport) {
    return { page: 1, limit: EXPORT_MAX, skip: 0, isExport: true };
  }

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;

  return { page, limit, skip, isExport: false };
}

module.exports = { parsePagination };