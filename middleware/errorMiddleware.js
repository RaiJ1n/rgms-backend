const errorMiddleware = (err, req, res, next) => {
  if (err.code === 11000) {
    return res.status(400).json({ success: false, message: 'This reference number has already been submitted' });
  }
  if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid ID format' });
  if (err.name === 'ValidationError') return res.status(400).json({ success: false, message: err.message });

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Server Error',
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
};

module.exports = errorMiddleware;