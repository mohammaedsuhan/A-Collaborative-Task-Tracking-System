# Task Tracker API

A RESTful backend for a collaborative task tracking and management application. Users create teams/projects, invite members, and create, assign, track, comment on and attach files to tasks — with real-time notifications and optional AI-assisted task writing.

**Stack:** Node.js · Express 5 · SQLite (`better-sqlite3`) · JWT · bcrypt · zod · multer

SQLite keeps setup to a single `npm install` (no database server needed). All data access goes through parameterised queries and a thin set of routers, so swapping in PostgreSQL later would be confined to `src/db` and the route SQL.

---

## Quick start

```bash
npm install
cp .env.example .env      # then set JWT_SECRET to a long random string
npm start                 # http://localhost:3000
npm test                  # 40 integration tests
```

Requires Node.js 18+. The database file (`./data/app.db`) and upload folder (`./uploads`) are created automatically on first run.

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | dev-only value | **Required in production** (the server refuses to start without it) |
| `JWT_EXPIRES_IN` | `2h` | Token lifetime |
| `DATABASE_PATH` | `./data/app.db` | SQLite file |
| `UPLOAD_DIR` | `./uploads` | Attachment storage |
| `MAX_UPLOAD_MB` | `10` | Max attachment size |
| `ANTHROPIC_API_KEY` | *(empty)* | Enables real AI generation; without it a template fallback is used |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Model used for AI features |

---

## User stories → endpoints

| # | Story | Endpoint |
|---|---|---|
| 1 | Create an account | `POST /api/auth/register` |
| 2 | Log in securely | `POST /api/auth/login` |
| 3 | View / update profile | `GET`, `PATCH /api/users/me` (+ `PUT /api/users/me/password`) |
| 4 | Create a task (title, description, due date) | `POST /api/tasks` |
| 5 | List tasks assigned to me | `GET /api/tasks?assignee=me` |
| 6 | Mark a task completed | `POST /api/tasks/:id/complete` (or `PATCH` with `status`) |
| 7 | Assign a task to a teammate | `POST /api/tasks/:id/assign` |
| 8 | Filter by status | `GET /api/tasks?status=open` |
| 9 | Search by title/description | `GET /api/tasks?q=landing` |
| 10 | Comments & attachments | `/api/tasks/:taskId/comments`, `/api/tasks/:taskId/attachments` |
| 11 | Create team, invite members | `POST /api/teams`, `POST /api/teams/:id/invitations`, `POST /api/invitations/:id/accept` |
| 12 | Log out | `POST /api/auth/logout` |
| 13 | Real-time notifications *(extension)* | `GET /api/notifications/stream` (SSE) |
| 14 | AI task descriptions / summaries *(extension)* | `POST /api/ai/description`, `POST /api/ai/tasks/:id/summary` |

---

## API reference

All endpoints are under `/api`, accept and return JSON (except file upload/download), and use `snake_case` field names. Authenticated endpoints need `Authorization: Bearer <token>`.

### Auth & profile

| Method | Path | Body / notes |
|---|---|---|
| POST | `/auth/register` | `{ name, email, password }` → `201 { user, token }`. Password: 8–72 chars, at least one letter and one number |
| POST | `/auth/login` | `{ email, password }` → `{ user, token }` |
| POST | `/auth/logout` | Revokes the presented token → `204` |
| GET | `/users/me` | Current profile |
| PATCH | `/users/me` | Any of `{ name, email, bio }` |
| PUT | `/users/me/password` | `{ current_password, new_password }` → `204` |

### Teams & invitations

| Method | Path | Notes |
|---|---|---|
| POST | `/teams` | `{ name, description? }` — creator becomes **owner** |
| GET | `/teams` | Teams I belong to |
| GET | `/teams/:id` | Details + members (members only) |
| PATCH / DELETE | `/teams/:id` | Owner only |
| DELETE | `/teams/:id/members/:userId` | Owner removes a member, or a member removes themself (leave). Their tasks become unassigned |
| POST | `/teams/:id/invitations` | `{ email }` — owner only |
| GET | `/teams/:id/invitations` | Owner only |
| GET | `/invitations` | Pending invitations addressed to me |
| POST | `/invitations/:id/accept` · `/decline` | Join (or refuse) a team |

### Tasks

| Method | Path | Notes |
|---|---|---|
| POST | `/tasks` | `{ team_id, title, description?, due_date?, priority?, status?, assignee_id? }` |
| GET | `/tasks` | List with filters, search, sorting, pagination (below) |
| GET | `/tasks/:id` | Includes `comment_count`, `attachment_count` |
| PATCH | `/tasks/:id` | Any of `title, description, due_date, priority, status, assignee_id` |
| POST | `/tasks/:id/assign` | `{ assignee_id }` — `null` unassigns |
| POST | `/tasks/:id/complete` | Sets `status=completed` and `completed_at` |
| DELETE | `/tasks/:id` | Task creator or team owner |

**Statuses:** `open`, `in_progress`, `completed` · **Priorities:** `low`, `medium`, `high`
**Dates:** `YYYY-MM-DD` or ISO-8601 datetime; always returned as UTC ISO strings.

**`GET /tasks` query parameters** (all optional, combinable)

| Param | Example | Meaning |
|---|---|---|
| `assignee` | `me` · `unassigned` · `7` | Filter by assignee |
| `team_id` | `3` | Restrict to one team |
| `status` | `open` or `open,in_progress` | One or more statuses |
| `priority` | `high,medium` | One or more priorities |
| `q` | `landing` | Case-insensitive search in title **and** description (wildcards are escaped) |
| `due_before` / `due_after` | `2026-12-31` | Due-date range (inclusive) |
| `overdue` | `true` | Past due and not completed |
| `sort_by` | `created_at` *(default)*, `updated_at`, `due_date`, `title`, `status`, `priority` | Tasks without a due date always sort last |
| `order` | `asc` · `desc` *(default)* | |
| `page`, `limit` | `1`, `20` (max 100) | Pagination |

Response: `{ tasks: [...], pagination: { page, limit, total, total_pages } }`

### Comments

`POST|GET /tasks/:taskId/comments` · `PATCH|DELETE /tasks/:taskId/comments/:commentId`
Edit = author only. Delete = author or team owner.

### Attachments

```bash
curl -X POST http://localhost:3000/api/tasks/1/attachments \
  -H "Authorization: Bearer $TOKEN" -F "file=@./design.png"
```

`POST|GET /tasks/:taskId/attachments` · `GET .../:attachmentId/download` · `DELETE .../:attachmentId`
Uploader or team owner may delete. Max size is configurable; executable types (`.exe`, `.sh`, `.bat`, …) are rejected.

### Notifications (real-time)

A notification is stored and pushed live when you are **assigned** a task, a task you created/own is **updated or completed**, someone **comments** or **attaches a file**, you are **invited** to a team, or your invitation is **accepted**. You are never notified of your own actions.

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | `?unread=true&page=&limit=` → includes `unread_count` |
| POST | `/notifications/:id/read` · `/notifications/read-all` | Mark read |
| GET | `/notifications/stream` | **Server-Sent Events** |

```js
// Browsers' EventSource can't set headers, so the stream (and only the stream)
// also accepts the JWT as ?token=
const es = new EventSource(`/api/notifications/stream?token=${jwt}`);
es.addEventListener('notification', (e) => console.log(JSON.parse(e.data)));
```

```bash
curl -N "http://localhost:3000/api/notifications/stream?token=$TOKEN"
```

### AI assistance

| Method | Path | Body |
|---|---|---|
| POST | `/ai/description` | `{ title, notes? }` → `{ description, source }` |
| POST | `/ai/tasks/:id/summary` | Summarises a task and its comment thread → `{ summary, source }` |

With `ANTHROPIC_API_KEY` set, these call the Anthropic Messages API (`source: "ai"`). Without a key, or if the upstream call fails, a deterministic template is returned instead (`source: "template"`) so the feature never hard-fails. User text is passed to the model inside delimited tags and flagged as untrusted data. Endpoints are rate-limited to 20 requests/minute per user.

### Errors

Every error uses one shape:

```json
{ "error": { "status": 400, "message": "Validation failed",
             "details": [{ "in": "body", "field": "password", "message": "Password must contain a number" }] } }
```

`400` validation · `401` unauthenticated · `403` not allowed · `404` not found · `409` conflict · `413` file too large · `429` rate limited.

---

## Design notes

**Authentication.** Passwords are hashed with bcrypt (cost 12). Sessions are stateless JWTs (HS256) carrying a unique `jti`. Logout writes the `jti` to a `revoked_tokens` table (purged once expired), so a stolen-but-logged-out token is useless — something plain JWTs can't do on their own. Login returns the same error for a wrong password and an unknown email, and does equivalent hashing work in both cases to blunt user enumeration.

**Authorization.** Everything is scoped by team membership. Non-members get `403` on a team's tasks, comments and attachments, and task lists only ever include tasks from the caller's own teams. Owner-only actions: manage team, invite, remove others. Task assignees must belong to the task's team.

**Data model** (`src/db/schema.sql`): `users`, `teams`, `team_members` (role: owner/member), `team_invitations`, `tasks`, `comments`, `attachments`, `notifications`, `revoked_tokens`. Foreign keys cascade, so deleting a team or task removes its dependants. Indexes cover the common filters (team, assignee, status, due date).

**Security measures.** Parameterised SQL everywhere; sort columns come from a whitelist rather than user input; `helmet` headers; rate limiting (strict on login/register); request body limit; uploads are stored under random UUID names (client filenames never touch the filesystem path), authorised *before* any bytes are written, and always served as downloads.

**Why SSE rather than WebSockets** for notifications: updates flow one way (server → client), SSE works over plain HTTP, reconnects automatically in browsers, and needs no extra dependency. A 25-second heartbeat keeps idle connections open through proxies. Multiple tabs per user are supported.

## Project structure

```
src/
  app.js                 # builds the Express app (database & AI service are injected)
  server.js              # entry point, graceful shutdown
  config.js              # environment configuration
  db/                    # schema.sql + connection/migration
  middleware/            # auth (JWT), validate (zod), error handler
  routes/                # auth, users, teams, tasks, comments, attachments, notifications, ai
  services/              # access (authorization), notifier (persist + SSE push), ai
  utils/                 # errors, shared zod schemas, token signing
tests/api.test.js        # end-to-end tests covering every user story
```

## Testing

`npm test` runs 40 integration tests (Node's built-in test runner + supertest) against an in-memory database. They cover each user story plus the negative paths: authorization boundaries between teams, validation, SQL-injection/LIKE-wildcard handling, upload abuse (blocked types, path traversal, unauthorised uploads), token revocation, live SSE delivery, and the AI service with both a mocked upstream and a failing one.

## Known limitations / next steps

- SQLite is single-writer; for a multi-instance deployment move to PostgreSQL, and move SSE fan-out to a shared pub/sub (e.g. Redis) since connections are currently tracked in process memory.
- Attachments are stored on local disk; use object storage (S3) for production.
- No email delivery for invitations — invitees see them in-app via `GET /api/invitations`.
- No refresh tokens; sessions last `JWT_EXPIRES_IN` and then require a new login.
