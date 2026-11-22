'use strict';

const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { id } = require('../utils/schemas');

const descriptionSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  notes: z.string().trim().max(2000).optional(),
});
const summaryParams = z.object({ id });

/** AI-assisted task writing. Mounted at /api/ai. */
function createAiRouter(db, authenticate, access, ai) {
  const router = express.Router();
  router.use(authenticate);

  // Each call can cost money upstream, so throttle per user.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => config.isTest,
      keyGenerator: (req) => `user:${req.user.id}`,
      message: { error: { status: 429, message: 'Too many AI requests, slow down' } },
    })
  );

  // User story 14: draft a description from a title (+ optional rough notes)
  router.post('/description', validate({ body: descriptionSchema }), async (req, res) => {
    const { text, source } = await ai.generateDescription(req.valid.body);
    res.json({ description: text, source });
  });

  // Summarise a task and its comment thread
  router.post('/tasks/:id/summary', validate({ params: summaryParams }), async (req, res) => {
    const { task } = access.requireTaskAccess(req.valid.params.id, req.user.id);
    const comments = db
      .prepare(
        `SELECT c.body, u.name FROM comments c JOIN users u ON u.id = c.user_id
          WHERE c.task_id = ? ORDER BY c.created_at, c.id`
      )
      .all(task.id)
      .map((c) => ({ body: c.body, author: { name: c.name } }));

    const { text, source } = await ai.summarizeTask({ task, comments });
    res.json({ summary: text, source });
  });

  return router;
}

module.exports = { createAiRouter };
