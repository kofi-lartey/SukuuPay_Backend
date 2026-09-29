import { NODE_ENV } from '../config/env.js';

const errorHandler = (error, _req, res, _next) => {
  // Duplicate key on a unique index (e.g. email already registered).
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      message: `An account with this ${field} already exists`,
    });
  }

  if (error.name === 'ValidationError') {
    return res.status(422).json({
      success: false,
      message: error.message,
      errors: Object.values(error.errors || {}).map((item) => item.message),
    });
  }

  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  console.error('Unhandled error:', error);
  res.status(error.status || 500).json({
    success: false,
    message: error.status ? error.message : 'Something went wrong',
    ...(NODE_ENV === 'development' ? { stack: error.stack } : {}),
  });
};

export default errorHandler;
