'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { badRequest, forbidden } = require('../utils/errors');
const { id, idParam, isoDate } = require('../utils/schemas');

const STATUSES = ['open', 'in_progress', 'completed'];
const PRIORITIES = ['low', 'medium', 'high'];

/** Whitelisted sort keys -> SQL expressions (never interpolate user input directly). */
const SORTS = {
  created_at: 't.created_at',
  updated_at: 't.updated_at',
  due_date: 't.due_date',
  title: 't.title COLLATE NOCASE',
  status: 't.status',
  priority: "CASE t.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
};

/** "open,in_progress" -> ['open', 'in_progress'], validated against an allowed set. */
const csvEnum = (values) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.enum(values)).min(1));

const createSchema = z.object({
  team_id: id,
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().max(5000).nullish(),
  due_date: isoDate.nullish(),
  priority: z.enum(PRIORITIES).default('medium'),
  status: z.enum(STATUSES).default('open'),
  assignee_id: id.nullish(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    due_date: isoDate.nullable(),
    priority: z.enum(PRIORITIES),
    status: z.enum(STATUSES),
    assignee_id: id.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const assignSchema = z.object({ assignee_id: id.nullable() });

const listSchema = z.object({
  team_id: id.optional(),
  assignee: z.union([z.enum(['me', 'unassigned']), id]).optional(),
  status: csvEnum(STATUSES).optional(),
  priority: csvEnum(PRIORITIES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  due_before: isoDate.optional(),
  due_after: isoDate.optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sort_by: z.enum(Object.keys(SORTS)).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const TASK_SELECT = `
  SELECT t.*, tm.name AS team_name,
         c.name AS creator_name, a.name AS assignee_name,
         (SELECT COUNT(*) FROM comments    WHERE task_id = t.id) AS comment_count,
         (SELECT COUNT(*) FROM attachments WHERE task_id = t.id) AS attachment_count
    FROM tasks t
    JOIN teams tm ON tm.id = t.team_id
    JOIN users c  ON c.id = t.creator_id
    LEFT JOIN users a ON a.id = t.assignee_id`;

/** Shape a joined DB row into the public API representation. */
function present(row) {
  return {
    id: row.id,
    team_id: row.team_id,
    team_name: row.team_name,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    creator: { id: row.creator_id, name: row.creator_name },
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    comment_count: row.comment_count,
    attachment_count: row.attachment_count,
  };
}

/** Escape LIKE wildcards so a search for "100%" matches literally. */
const likePattern = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

function createTasksRouter(db, authenticate, access, notifier) {
  const router = express.Router();
  router.use(authenticate);

  const loadTask = db.prepare(`${TASK_SELECT} WHERE t.id = ?`);
  const insertTask = db.prepare(
    `INSERT INTO tasks (team_id, title, description, due_date, priority, status, creator_id, assignee_id, completed_at)
     VALUES (@team_id, @title, @description, @due_date, @priority, @status, @creator_id, @assignee_id, @completed_at)`
  );

  const nowIso = () => new Date().toISOString();

  /** The assignee must belong to the same team as the task. */
  function assertAssignable(teamId, assigneeId) {
    if (assigneeId != null && !access.isMember(teamId, assigneeId)) {
      throw badRequest("Assignee must be a member of the task's team");
    }
  }

  /**
   * Apply a validated set of changes to a task, then notify the right people.
   * Shared by PATCH, assign and complete so behaviour is identical everywhere.
   */
  function applyChanges(task, changes, actor) {
    if ('assignee_id' in changes) assertAssignable(task.team_id, changes.assignee_id);

    const next = { ...changes };
    if ('status' in changes && changes.status !== task.status) {
      next.completed_at = changes.status === 'completed' ? nowIso() : null;
    }

    const columns = Object.keys(next); // keys originate from the zod schemas, not the client
    if (columns.length) {
      const assignments = columns.map((c) => `${c} = @${c}`).join(', ');
      db.prepare(
        `UPDATE tasks SET ${assignments}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`
      ).run({ ...next, id: task.id });
    }

    const updated = loadTask.get(task.id);

    // --- notifications ---
    const assigneeChanged = 'assignee_id' in changes && changes.assignee_id !== task.assignee_id;
    if (assigneeChanged && changes.assignee_id) {
      notifier.notify({
        userId: changes.assignee_id,
        actorId: actor.id,
        type: 'task_assigned',
        message: `${actor.name} assigned you "${updated.title}"`,
        taskId: task.id,
        teamId: task.team_id,
      });
    }
    const otherChanges = columns.filter((c) => !['assignee_id', 'completed_at'].includes(c));
    if (otherChanges.length) {
      const justCompleted = changes.status === 'completed' && task.status !== 'completed';
      const type = justCompleted ? 'task_completed' : 'task_updated';
      const message = justCompleted
        ? `${actor.name} completed "${updated.title}"`
        : `${actor.name} updated "${updated.title}" (${otherChanges.join(', ')})`;
      // Tell the assignee and the creator — except whoever just got the "assigned" ping.
      const recipients = new Set([updated.assignee_id, updated.creator_id]);
      if (assigneeChanged) recipients.delete(changes.assignee_id);
      for (const userId of recipients) {
        notifier.notify({ userId, actorId: actor.id, type, message, taskId: task.id, teamId: task.team_id });
      }
    }

    return updated;
  }

  // ---- Create --------------------------------------------------------------

  // User story 4: create a task (optionally assigned right away)
  router.post('/', validate({ body: createSchema }), (req, res) => {
    const body = req.valid.body;
    access.requireMember(body.team_id, req.user.id);
    assertAssignable(body.team_id, body.assignee_id);

    const { lastInsertRowid } = insertTask.run({
      team_id: body.team_id,
      title: body.title,
      description: body.description ?? null,
      due_date: body.due_date ?? null,
      priority: body.priority,
      status: body.status,
      creator_id: req.user.id,
      assignee_id: body.assignee_id ?? null,
      completed_at: body.status === 'completed' ? nowIso() : null,
    });
    const task = loadTask.get(lastInsertRowid);

    if (task.assignee_id) {
      notifier.notify({
        userId: task.assignee_id,
        actorId: req.user.id,
        type: 'task_assigned',
        message: `${req.user.name} assigned you "${task.title}"`,
        taskId: task.id,
        teamId: task.team_id,
      });
    }
    res.status(201).json({ task: present(task) });
  });

  // ---- List / filter / sort / search --------------------------------------

  // User stories 5, 8, 9: my tasks, filter by status, search by title/description
  router.get('/', validate({ query: listSchema }), (req, res) => {
    const f = req.valid.query;
    if (f.team_id) access.requireMember(f.team_id, req.user.id);

    // Only tasks belonging to teams the caller is a member of are ever visible.
    const where = ['t.team_id IN (SELECT team_id FROM team_members WHERE user_id = @me)'];
    const params = { me: req.user.id };

    if (f.team_id) {
      where.push('t.team_id = @team_id');
      params.team_id = f.team_id;
    }
    if (f.assignee === 'me') {
      where.push('t.assignee_id = @me');
    } else if (f.assignee === 'unassigned') {
      where.push('t.assignee_id IS NULL');
    } else if (f.assignee) {
      where.push('t.assignee_id = @assignee');
      params.assignee = f.assignee;
    }

    for (const [key, column] of [
      ['status', 't.status'],
      ['priority', 't.priority'],
    ]) {
      if (f[key]) {
        const names = f[key].map((value, i) => {
          params[`${key}${i}`] = value;
          return `@${key}${i}`;
        });
        where.push(`${column} IN (${names.join(', ')})`);
      }
    }

    if (f.q) {
      where.push("(t.title LIKE @q ESCAPE '\\' OR t.description LIKE @q ESCAPE '\\')");
      params.q = likePattern(f.q);
    }
    if (f.due_before) {
      where.push('t.due_date <= @due_before');
      params.due_before = f.due_before;
    }
    if (f.due_after) {
      where.push('t.due_date >= @due_after');
      params.due_after = f.due_after;
    }
    if (f.overdue) {
      where.push("t.due_date < @now AND t.status != 'completed'");
      params.now = nowIso();
    }

    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    // Tasks without a due date always sort last when ordering by due date.
    const nullsLast = f.sort_by === 'due_date' ? 't.due_date IS NULL, ' : '';
    const orderBy = `${nullsLast}${SORTS[f.sort_by]} ${dir}, t.id ${dir}`;
    const whereSql = where.join(' AND ');

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM tasks t WHERE ${whereSql}`).get(params);
    const rows = db
      .prepare(`${TASK_SELECT} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: f.limit, offset: (f.page - 1) * f.limit });

    res.json({
      tasks: rows.map(present),
      pagination: { page: f.page, limit: f.limit, total, total_pages: Math.ceil(total / f.limit) },
    });
  });

  // ---- Read / update / delete ---------------------------------------------

  router.get('/:id', validate({ params: idParam }), (req, res) => {
    access.requireTaskAccess(req.valid.params.id, req.user.id);
    res.json({ task: present(loadTask.get(req.valid.params.id)) });
  });

  router.patch('/:id', validate({ params: idParam, body: updateSchema }), (req, res) => {
    const { task } = access.requireTaskAccess(req.valid.params.id, req.user.id);
    res.json({ task: present(applyChanges(task, req.valid.body, req.user)) });
  });

  // User story 7: assign (or unassign with null) a task to a team member
  router.post('/:id/assign', validate({ params: idParam, body: assignSchema }), (req, res) => {
    const { task } = access.requireTaskAccess(req.valid.params.id, req.user.id);
    res.json({ task: present(applyChanges(task, req.valid.body, req.user)) });
  });

  // User story 6: mark a task as completed
  router.post('/:id/complete', validate({ params: idParam }), (req, res) => {
    const { task } = access.requireTaskAccess(req.valid.params.id, req.user.id);
    res.json({ task: present(applyChanges(task, { status: 'completed' }, req.user)) });
  });

  // Only the task's creator or the team owner may delete it.
  router.delete('/:id', validate({ params: idParam }), (req, res) => {
    const { task, membership } = access.requireTaskAccess(req.valid.params.id, req.user.id);
    if (task.creator_id !== req.user.id && membership.role !== 'owner') {
      throw forbidden('Only the task creator or the team owner can delete a task');
    }
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { createTasksRouter, present };
