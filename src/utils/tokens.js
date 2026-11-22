'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

/** Sign a session JWT. Each token gets a unique `jti` so it can be revoked on logout. */
function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.expiresIn,
    jwtid: crypto.randomUUID(),
  });
}

module.exports = { signToken };
