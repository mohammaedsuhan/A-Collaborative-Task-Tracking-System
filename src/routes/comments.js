'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { forbidden, notFound } = require('../utils/errors');
const { id } = require('../utils/schemas');

const taskParams = z.object({ taskId: id });
const commentParams = z.object({ taskId: id, commentId: id });
const bodySchema = z.object({ body: z.string().trim().min(1, 'Comment cannot be empty').max(2000) });

/** Comments on a task. Mounted at /api/tasks/:taskId/comments. */
function createCommentsRouter(db, authenticate, access, notifier) {
  const router = express.Router({ mergeParams: true });
  router.use(authenticate);

  const SELECT = `SELECT c.id, c.task_id, c.body, c.created_at, c.updated_at,
                         u.id AS author_id, u.name AS author_name
                    FROM comments c JOIN users u ON u.id = c.user_id`;
  const present = (r) => ({
    id: r.id,
    task_id: r.task_id,
    body: r.body,
    author: { id: r.author_id, name: r.author_name },
    created_at: r.created_at,
    updated_at: r.updated_at,
  });

  /** Load a comment that belongs to the task in the URL, or 404. */
  function findComment(taskId, commentId) {
    const row = db.prepare(`${SELECT} WHERE c.id = ? AND c.task_id = ?`).get(commentId, taskId);
    if (!row) throw notFound('Comment not found');
    return row;
  }

  // User story 10: add a comment
  router.post('/', validate({ params: taskParams, body: bodySchema }), (req, res) => {
    const { task } = access.requireTaskAccess(req.valid.params.taskId, req.user.id);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)')
      .run(task.id, req.user.id, req.valid.body.body);

    for (const userId of new Set([task.assignee_id, task.creator_id])) {
      notifier.notify({
        userId,
        actorId: req.user.id,
        type: 'comment_added',
        message: `${req.user.name} commented on "${task.title}"`,
        taskId: task.id,
        teamId: task.team_id,
      });
    }
    res.status(201).json({ comment: present(findComment(task.id, lastInsertRowid)) });
  });

  router.get('/', validate({ params: taskParams }), (req, res) => {
    const { task } = access.requireTaskAccess(req.valid.params.taskId, req.user.id);
    const rows = db.prepare(`${SELECT} WHERE c.task_id = ? ORDER BY c.created_at, c.id`).all(task.id);
    res.json({ comments: rows.map(present) });
  });

  // Only the author may edit their comment.
  router.patch('/:commentId', validate({ params: commentParams, body: bodySchema }), (req, res) => {
    const { taskId, commentId } = req.valid.params;
    access.requireTaskAccess(taskId, req.user.id);
    const existing = findComment(taskId, commentId);
    if (existing.author_id !== req.user.id) throw forbidden('You can only edit your own comments');

    db.prepare("UPDATE comments SET body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      req.valid.body.body,
      commentId
    );
    res.json({ comment: present(findComment(taskId, commentId)) });
  });

  // The author or the team owner may delete a comment.
  router.delete('/:commentId', validate({ params: commentParams }), (req, res) => {
    const { taskId, commentId } = req.valid.params;
    const { membership } = access.requireTaskAccess(taskId, req.user.id);
    const existing = findComment(taskId, commentId);
    if (existing.author_id !== req.user.id && membership.role !== 'owner') {
      throw forbidden('Only the comment author or the team owner can delete a comment');
    }
    db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    res.status(204).end();
  });

  return router;
}

module.exports = { createCommentsRouter };
