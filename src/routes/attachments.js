'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { badRequest, forbidden, notFound } = require('../utils/errors');
const { id } = require('../utils/schemas');

const taskParams = z.object({ taskId: id });
const attachmentParams = z.object({ taskId: id, attachmentId: id });

/** Executable / script types are refused outright. Everything else is stored and served as a download. */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.scr', '.sh', '.ps1', '.vbs', '.jar', '.apk',
]);

/** Attachments on a task. Mounted at /api/tasks/:taskId/attachments. */
function createAttachmentsRouter(db, authenticate, access, notifier) {
  const router = express.Router({ mergeParams: true });
  router.use(authenticate);

  fs.mkdirSync(config.uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      // Random on-disk name: the client-supplied name is never used to build a path.
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      // busboy decodes multipart filenames as latin1; browsers send UTF-8, so re-decode.
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(file.originalname).toLowerCase();
      if (BLOCKED_EXTENSIONS.has(ext)) return cb(badRequest(`Files of type "${ext}" are not allowed`));
      cb(null, true);
    },
  });

  const SELECT = `SELECT a.id, a.task_id, a.original_name, a.mime_type, a.size_bytes, a.created_at,
                         u.id AS uploader_id, u.name AS uploader_name
                    FROM attachments a JOIN users u ON u.id = a.user_id`;
  const present = (r) => ({
    id: r.id,
    task_id: r.task_id,
    filename: r.original_name,
    mime_type: r.mime_type,
    size_bytes: r.size_bytes,
    uploaded_by: { id: r.uploader_id, name: r.uploader_name },
    created_at: r.created_at,
    download_url: `/api/tasks/${r.task_id}/attachments/${r.id}/download`,
  });

  function findAttachment(taskId, attachmentId) {
    const row = db
      .prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?')
      .get(attachmentId, taskId);
    if (!row) throw notFound('Attachment not found');
    return row;
  }

  // Authorise *before* multer runs so unauthorised users can't write files to disk.
  const authoriseTask = (req, _res, next) => {
    access.requireTaskAccess(req.valid.params.taskId, req.user.id);
    next();
  };

  // User story 10: upload an attachment (multipart/form-data, field name "file")
  router.post(
    '/',
    validate({ params: taskParams }),
    authoriseTask,
    upload.single('file'),
    (req, res) => {
      if (!req.file) throw badRequest('No file uploaded: send multipart/form-data with a "file" field');
      const { task } = access.requireTaskAccess(req.valid.params.taskId, req.user.id);

      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO attachments (task_id, user_id, original_name, stored_name, mime_type, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(task.id, req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size);

      for (const userId of new Set([task.assignee_id, task.creator_id])) {
        notifier.notify({
          userId,
          actorId: req.user.id,
          type: 'attachment_added',
          message: `${req.user.name} attached "${req.file.originalname}" to "${task.title}"`,
          taskId: task.id,
          teamId: task.team_id,
        });
      }
      const row = db.prepare(`${SELECT} WHERE a.id = ?`).get(lastInsertRowid);
      res.status(201).json({ attachment: present(row) });
    }
  );

  router.get('/', validate({ params: taskParams }), (req, res) => {
    const { task } = access.requireTaskAccess(req.valid.params.taskId, req.user.id);
    const rows = db.prepare(`${SELECT} WHERE a.task_id = ? ORDER BY a.created_at, a.id`).all(task.id);
    res.json({ attachments: rows.map(present) });
  });

  router.get('/:attachmentId/download', validate({ params: attachmentParams }), (req, res, next) => {
    const { taskId, attachmentId } = req.valid.params;
    access.requireTaskAccess(taskId, req.user.id);
    const row = findAttachment(taskId, attachmentId);
    const file = path.join(config.uploadDir, row.stored_name);
    if (!fs.existsSync(file)) throw notFound('File is missing from storage');
    // Always force a download so uploaded HTML/SVG can never execute in our origin.
    res.download(file, row.original_name, (err) => err && next(err));
  });

  // The uploader or the team owner may delete an attachment.
  router.delete('/:attachmentId', validate({ params: attachmentParams }), (req, res) => {
    const { taskId, attachmentId } = req.valid.params;
    const { membership } = access.requireTaskAccess(taskId, req.user.id);
    const row = findAttachment(taskId, attachmentId);
    if (row.user_id !== req.user.id && membership.role !== 'owner') {
      throw forbidden('Only the uploader or the team owner can delete an attachment');
    }
    db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId);
    fs.rm(path.join(config.uploadDir, row.stored_name), { force: true }, () => {});
    res.status(204).end();
  });

  return router;
}

module.exports = { createAttachmentsRouter };
