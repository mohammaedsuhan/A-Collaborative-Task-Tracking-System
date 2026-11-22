'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized } = require('../utils/errors');

/**
 * Build the JWT authentication middleware.
 *
 * Tokens are read from `Authorization: Bearer <token>`. Browsers' EventSource
 * cannot set headers, so `allowQueryToken` additionally accepts `?token=` —
 * only enable that for the SSE stream route.
 *
 * A token is rejected if it is invalid, expired, or has been revoked by logout.
 */
function createAuthenticate(db, { allowQueryToken = false } = {}) {
  const isRevoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?');
  const findUser = db.prepare('SELECT id, email, name FROM users WHERE id = ?');

  return (req, _res, next) => {
    let token;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      token = header.slice(7).trim();
    } else if (allowQueryToken && typeof req.query.token === 'string') {
      token = req.query.token;
    }
    if (!token) return next(unauthorized());

    let payload;
    try {
      payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    } catch {
      return next(unauthorized('Invalid or expired token'));
    }

    if (isRevoked.get(payload.jti)) return next(unauthorized('Token has been revoked'));

    const user = findUser.get(Number(payload.sub));
    if (!user) return next(unauthorized('User no longer exists'));

    req.user = user;
    req.token = { jti: payload.jti, exp: payload.exp };
    next();
  };
}

module.exports = { createAuthenticate };
