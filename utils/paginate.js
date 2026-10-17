// Shared page/limit parsing for admin list endpoints (members, payments, classes)
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