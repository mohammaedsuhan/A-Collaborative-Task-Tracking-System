'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { notFound } = require('../utils/errors');
const { idParam } = require('../utils/schemas');

const listSchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Notification history plus a live Server-Sent Events stream.
 *
 * Client usage (browser):
 *   const es = new EventSource(`/api/notifications/stream?token=${jwt}`);
 *   es.addEventListener('notification', (e) => console.log(JSON.parse(e.data)));
 */
function createNotificationsRouter(db, authenticate, authenticateSse, notifier) {
  const router = express.Router();

  // User story 13 (extension): real-time push. Registered before the header-only auth below.
  router.get('/stream', authenticateSse, (req, res) => notifier.subscribe(req.user.id, req, res));

  router.use(authenticate);

  router.get('/', validate({ query: listSchema }), (req, res) => {
    const { unread, page, limit } = req.valid.query;
    const filter = unread ? 'AND is_read = 0' : '';

    const rows = db
      .prepare(
        `SELECT * FROM notifications WHERE user_id = ? ${filter}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(req.user.id, limit, (page - 1) * limit);
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.user.id);

    res.json({
      notifications: rows.map((r) => ({ ...r, is_read: Boolean(r.is_read) })),
      unread_count: n,
      page,
      limit,
    });
  });

  router.post('/read-all', (req, res) => {
    const { changes } = db
      .prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
      .run(req.user.id);
    res.json({ marked_read: changes });
  });

  router.post('/:id/read', validate({ params: idParam }), (req, res) => {
    const { changes } = db
      .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
      .run(req.valid.params.id, req.user.id);
    if (!changes) throw notFound('Notification not found');
    res.status(204).end();
  });

  return router;
}

module.exports = { createNotificationsRouter };
