'use strict';

const multer = require('multer');
const { HttpError } = require('../utils/errors');
const config = require('../config');

function notFoundHandler(req, _res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = 500;
  let message = 'Internal server error';
  let details;

  if (err instanceof HttpError) {
    ({ status, message, details } = err);
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (max ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`
        : err.message;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large';
  }

  if (status >= 500 && !config.isTest) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  res.status(status).json({ error: { status, message, ...(details && { details }) } });
}

module.exports = { notFoundHandler, errorHandler };
