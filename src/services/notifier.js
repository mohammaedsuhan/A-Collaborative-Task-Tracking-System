'use strict';

/**
 * Notifications: every event is persisted (so users can fetch history and
 * mark items read) and, if the recipient has an open Server-Sent Events
 * connection, pushed to them immediately.
 */
function createNotifier(db) {
  /** userId -> Set of active SSE responses (a user may have several tabs open). */
  const clients = new Map();

  const insert = db.prepare(
    `INSERT INTO notifications (user_id, type, message, task_id, team_id)
     VALUES (@userId, @type, @message, @taskId, @teamId)`
  );
  const getById = db.prepare('SELECT * FROM notifications WHERE id = ?');

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Persist a notification and push it live. Never notifies someone about their own action. */
  function notify({ userId, actorId, type, message, taskId = null, teamId = null }) {
    if (userId == null || userId === actorId) return null;
    const { lastInsertRowid } = insert.run({ userId, type, message, taskId, teamId });
    const row = getById.get(lastInsertRowid);
    const notification = { ...row, is_read: Boolean(row.is_read) };
    for (const res of clients.get(userId) ?? []) send(res, 'notification', notification);
    return notification;
  }

  /** Attach an SSE response for a user. Returns nothing; cleanup is automatic. */
  function subscribe(userId, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    });
    send(res, 'connected', { userId });

    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(res);

    // Comment lines keep idle connections from being closed by proxies.
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
    heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      const set = clients.get(userId);
      set?.delete(res);
      if (set && set.size === 0) clients.delete(userId);
    });
  }

  function connectionCount(userId) {
    return clients.get(userId)?.size ?? 0;
  }

  return { notify, subscribe, connectionCount };
}

module.exports = { createNotifier };
