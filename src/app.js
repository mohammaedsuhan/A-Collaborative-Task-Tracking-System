'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { createAuthenticate } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { createAccess } = require('./services/access');
const { createNotifier } = require('./services/notifier');
const { createAiService } = require('./services/ai');
const { createAuthRouter } = require('./routes/auth');
const { createUsersRouter } = require('./routes/users');
const { createTeamsRouters } = require('./routes/teams');
const { createTasksRouter } = require('./routes/tasks');
const { createCommentsRouter } = require('./routes/comments');
const { createAttachmentsRouter } = require('./routes/attachments');
const { createNotificationsRouter } = require('./routes/notifications');
const { createAiRouter } = require('./routes/ai');

/**
 * Build the Express application. The database (and optionally the AI service)
 * are injected so tests can run against an in-memory SQLite instance.
 */
function createApp({ db, ai = createAiService(config.ai) }) {
  const app = express();

  const authenticate = createAuthenticate(db);
  const authenticateSse = createAuthenticate(db, { allowQueryToken: true });
  const access = createAccess(db);
  const notifier = createNotifier(db);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // Brute-force protection on credential endpoints; a general cap everywhere else.
  const limiter = (limit, windowMs) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => config.isTest,
      message: { error: { status: 429, message: 'Too many requests, please try again later' } },
    });
  app.use('/api/auth/login', limiter(20, 15 * 60_000));
  app.use('/api/auth/register', limiter(20, 15 * 60_000));
  app.use('/api', limiter(600, 15 * 60_000));

  app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  const { teams, invitations } = createTeamsRouters(db, authenticate, access, notifier);

  app.use('/api/auth', createAuthRouter(db, authenticate));
  app.use('/api/users', createUsersRouter(db, authenticate));
  app.use('/api/teams', teams);
  app.use('/api/invitations', invitations);
  app.use('/api/tasks/:taskId/comments', createCommentsRouter(db, authenticate, access, notifier));
  app.use('/api/tasks/:taskId/attachments', createAttachmentsRouter(db, authenticate, access, notifier));
  app.use('/api/tasks', createTasksRouter(db, authenticate, access, notifier));
  app.use('/api/notifications', createNotificationsRouter(db, authenticate, authenticateSse, notifier));
  app.use('/api/ai', createAiRouter(db, authenticate, access, ai));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, notifier };
}

module.exports = { createApp };
