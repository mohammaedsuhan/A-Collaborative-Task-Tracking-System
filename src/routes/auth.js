'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { conflict, unauthorized } = require('../utils/errors');
const { signToken } = require('../utils/tokens');
const config = require('../config');

// 12 rounds in production; minimal cost under test so the suite stays fast.
const BCRYPT_ROUNDS = config.isTest ? 4 : 12;
// Used to equalise response time when the email is unknown (prevents user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters') // bcrypt ignores bytes beyond 72
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.email('Invalid email address').max(254).transform((e) => e.toLowerCase()),
  password,
});

const loginSchema = z.object({
  email: z.email('Invalid email address').transform((e) => e.toLowerCase()),
  password: z.string().min(1, 'Password is required'),
});

function createAuthRouter(db, authenticate) {
  const router = express.Router();

  const insertUser = db.prepare(
    'INSERT INTO users (email, name, password_hash) VALUES (@email, @name, @hash)'
  );
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const findById = db.prepare(
    'SELECT id, email, name, bio, created_at FROM users WHERE id = ?'
  );
  const revoke = db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)');
  const purgeExpired = db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?');

  // User story 1: create an account
  router.post('/register', validate({ body: registerSchema }), (req, res) => {
    const { name, email, password: plain } = req.valid.body;
    if (findByEmail.get(email)) throw conflict('An account with this email already exists');

    const hash = bcrypt.hashSync(plain, BCRYPT_ROUNDS);
    const { lastInsertRowid } = insertUser.run({ email, name, hash });
    const user = findById.get(lastInsertRowid);

    res.status(201).json({ user, token: signToken(user.id) });
  });

  // User story 2: log in
  router.post('/login', validate({ body: loginSchema }), (req, res) => {
    const { email, password: plain } = req.valid.body;
    const row = findByEmail.get(email);
    const ok = bcrypt.compareSync(plain, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) throw unauthorized('Invalid email or password');

    res.json({ user: findById.get(row.id), token: signToken(row.id) });
  });

  // User story 12: log out — revoke the presented token until it would have expired anyway
  router.post('/logout', authenticate, (req, res) => {
    revoke.run(req.token.jti, req.token.exp);
    purgeExpired.run(Math.floor(Date.now() / 1000));
    res.status(204).end();
  });

  return router;
}

module.exports = { createAuthRouter, passwordSchema: password, BCRYPT_ROUNDS };
