'use strict';

/** An error that maps directly onto an HTTP response. */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

module.exports = {
  HttpError,
  badRequest: (msg = 'Bad request', details) => new HttpError(400, msg, details),
  unauthorized: (msg = 'Authentication required') => new HttpError(401, msg),
  forbidden: (msg = 'You do not have access to this resource') => new HttpError(403, msg),
  notFound: (msg = 'Resource not found') => new HttpError(404, msg),
  conflict: (msg = 'Conflict') => new HttpError(409, msg),
};
