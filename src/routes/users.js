'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { badRequest, conflict, unauthorized } = require('../utils/errors');
const { passwordSchema, BCRYPT_ROUNDS } = require('./auth');

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.email('Invalid email address').max(254).transform((e) => e.toLowerCase()),
    bio: z.string().trim().max(500).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: passwordSchema,
});

function createUsersRouter(db, authenticate) {
  const router = express.Router();
  router.use(authenticate);

  const findProfile = db.prepare(
    'SELECT id, email, name, bio, created_at, updated_at FROM users WHERE id = ?'
  );
  const findByEmail = db.prepare('SELECT id FROM users WHERE email = ?');
  const findHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');

  // User story 3: view profile
  router.get('/me', (req, res) => {
    res.json({ user: findProfile.get(req.user.id) });
  });

  // User story 3: update profile (only the provided fields change)
  router.patch('/me', validate({ body: updateProfileSchema }), (req, res) => {
    const changes = req.valid.body;

    if (changes.email) {
      const existing = findByEmail.get(changes.email);
      if (existing && existing.id !== req.user.id) throw conflict('Email is already in use');
    }

    const columns = Object.keys(changes); // keys are constrained by the zod schema above
    const assignments = columns.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(
      `UPDATE users SET ${assignments}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`
    ).run({ ...changes, id: req.user.id });

    res.json({ user: findProfile.get(req.user.id) });
  });

  router.put('/me/password', validate({ body: changePasswordSchema }), (req, res) => {
    const { current_password: current, new_password: next } = req.valid.body;
    const { password_hash: hash } = findHash.get(req.user.id);

    if (!bcrypt.compareSync(current, hash)) throw unauthorized('Current password is incorrect');
    if (current === next) throw badRequest('New password must differ from the current one');

    db.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      bcrypt.hashSync(next, BCRYPT_ROUNDS),
      req.user.id
    );
    res.status(204).end();
  });

  return router;
}

module.exports = { createUsersRouter };
