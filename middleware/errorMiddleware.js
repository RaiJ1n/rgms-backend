// Central error handler.
//
// Two things matter for attendance (and everything else that writes to the DB):
//  1. Failures must leave a diagnostic trail on the SERVER. Before this, an
//     unexpected error (DB timeout, validation, duplicate key) was turned into
//     a JSON response and never logged, so a failing write was invisible.
//  2. The client must get an honest message. Before this, EVERY duplicate-key
//     error (E11000) was reported as "This reference number has already been
//     submitted" - correct only for payment references - which made unrelated
//     failures (e.g. a duplicate attendance/session key) look like a payment
//     problem.
// Logs carry method, path, error name/code and message only - never request
// bodies, headers, tokens, or connection strings.
const isProd = () => process.env.NODE_ENV === 'production';

function logError(err, req, status) {
  console.error('[ERROR]', {
    at: new Date().toISOString(),
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0],
    status,
    name: err.name,
    code: err.code,
    keyPattern: err.keyPattern ? Object.keys(err.keyPattern) : undefined,
    message: err.message,
  });
}

const errorMiddleware = (err, req, res, next) => {
  if (err.code === 11000) {
    logError(err, req, 409);
    const keys = err.keyPattern ? Object.keys(err.keyPattern) : [];
    const isPaymentRef = keys.includes('transactionNumber') || /transactionNumber|referenceNumber/.test(err.message || '');
    if (isPaymentRef) {
      return res.status(400).json({ success: false, message: 'This reference number has already been submitted' });
    }
    return res.status(409).json({ success: false, message: 'This record already exists or was just created. Refresh and try again.' });
  }
  if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid ID format' });
  if (err.name === 'ValidationError') return res.status(400).json({ success: false, message: err.message });

  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) logError(err, req, statusCode);

  // In production a 5xx never echoes driver/internal text to the user; it says
  // the save did not happen and that retrying is safe.
  const message = statusCode >= 500 && isProd()
    ? 'The request could not be saved. Nothing was recorded - please try again.'
    : err.message || 'Server Error';
  res.status(statusCode).json({
    success: false,
    message,
    retryable: statusCode >= 500 ? true : undefined,
    stack: isProd() ? undefined : err.stack,
  });
};

module.exports = errorMiddleware;
