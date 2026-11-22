'use strict';

const config = require('./config');
const { createDatabase } = require('./db');
const { createApp } = require('./app');

const db = createDatabase();
const { app } = createApp({ db });

const server = app.listen(config.port, () => {
  console.log(`Task Tracker API listening on http://localhost:${config.port}`);
  if (!config.ai.apiKey) console.log('ANTHROPIC_API_KEY not set: AI endpoints will use template fallback');
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
