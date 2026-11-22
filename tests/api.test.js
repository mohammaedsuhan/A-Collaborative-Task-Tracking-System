'use strict';

// Must be set before any app module reads config.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktracker-uploads-'));

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { createAiService } = require('../src/services/ai');

const PASSWORD = 'Passw0rdOK';

describe('Task Tracker API', () => {
  let db, app, notifier, alice, bob, carol, team, task;

  const api = (method, url, token) => {
    const req = request(app)[method](url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const register = async (name, email) => {
    const res = await api('post', '/api/auth/register').send({ name, email, password: PASSWORD });
    assert.equal(res.status, 201);
    return { ...res.body.user, token: res.body.token };
  };
  const notificationsFor = async (user) =>
    (await api('get', '/api/notifications', user.token)).body.notifications;

  before(() => {
    db = createDatabase(':memory:');
    ({ app, notifier } = createApp({ db }));
  });

  after(() => {
    db.close();
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ Auth
  describe('auth (stories 1, 2, 12)', () => {
    test('registers a user and never leaks the password hash', async () => {
      const res = await api('post', '/api/auth/register').send({
        name: 'Alice',
        email: 'Alice@Example.com',
        password: PASSWORD,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.email, 'alice@example.com'); // normalised
      assert.ok(res.body.token);
      assert.equal(res.body.user.password_hash, undefined);
      alice = { ...res.body.user, token: res.body.token };

      const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(alice.id);
      assert.match(stored.password_hash, /^\$2[aby]\$/); // bcrypt, not plaintext
    });

    test('rejects duplicate email, weak password and bad email', async () => {
      const dup = await api('post', '/api/auth/register').send({
        name: 'X',
        email: 'alice@example.com',
        password: PASSWORD,
      });
      assert.equal(dup.status, 409);

      const weak = await api('post', '/api/auth/register').send({
        name: 'X',
        email: 'x@example.com',
        password: 'short',
      });
      assert.equal(weak.status, 400);
      assert.ok(weak.body.error.details.length >= 1);

      const bad = await api('post', '/api/auth/register').send({
        name: 'X',
        email: 'nope',
        password: PASSWORD,
      });
      assert.equal(bad.status, 400);
    });

    test('logs in with correct credentials; wrong password and unknown email look identical', async () => {
      const ok = await api('post', '/api/auth/login').send({
        email: 'alice@example.com',
        password: PASSWORD,
      });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.token);

      const wrong = await api('post', '/api/auth/login').send({
        email: 'alice@example.com',
        password: 'Wrong1234',
      });
      const unknown = await api('post', '/api/auth/login').send({
        email: 'ghost@example.com',
        password: PASSWORD,
      });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(wrong.body.error.message, unknown.body.error.message);
    });

    test('protected routes require a valid token', async () => {
      assert.equal((await api('get', '/api/users/me')).status, 401);
      assert.equal((await api('get', '/api/users/me', 'garbage')).status, 401);
    });

    test('logout revokes the token', async () => {
      const login = await api('post', '/api/auth/login').send({
        email: 'alice@example.com',
        password: PASSWORD,
      });
      const { token } = login.body;
      assert.equal((await api('get', '/api/users/me', token)).status, 200);
      assert.equal((await api('post', '/api/auth/logout', token)).status, 204);
      const after = await api('get', '/api/users/me', token);
      assert.equal(after.status, 401);
      // other sessions are unaffected
      assert.equal((await api('get', '/api/users/me', alice.token)).status, 200);
    });
  });

  // --------------------------------------------------------------- Profile
  describe('profile (story 3)', () => {
    before(async () => {
      bob = await register('Bob', 'bob@example.com');
      carol = await register('Carol', 'carol@example.com');
    });

    test('views and updates own profile', async () => {
      const me = await api('get', '/api/users/me', alice.token);
      assert.equal(me.body.user.name, 'Alice');

      const upd = await api('patch', '/api/users/me', alice.token).send({
        name: 'Alice A.',
        bio: 'Team lead',
      });
      assert.equal(upd.status, 200);
      assert.equal(upd.body.user.name, 'Alice A.');
      assert.equal(upd.body.user.bio, 'Team lead');
      assert.equal(upd.body.user.email, 'alice@example.com'); // untouched
    });

    test('rejects empty update and email collisions', async () => {
      assert.equal((await api('patch', '/api/users/me', alice.token).send({})).status, 400);
      const clash = await api('patch', '/api/users/me', alice.token).send({ email: 'bob@example.com' });
      assert.equal(clash.status, 409);
    });

    test('changes password (old one stops working)', async () => {
      const wrong = await api('put', '/api/users/me/password', carol.token).send({
        current_password: 'Nope12345',
        new_password: 'NewPassw0rd',
      });
      assert.equal(wrong.status, 401);

      const ok = await api('put', '/api/users/me/password', carol.token).send({
        current_password: PASSWORD,
        new_password: 'NewPassw0rd',
      });
      assert.equal(ok.status, 204);
      assert.equal(
        (await api('post', '/api/auth/login').send({ email: 'carol@example.com', password: PASSWORD }))
          .status,
        401
      );
      assert.equal(
        (await api('post', '/api/auth/login').send({ email: 'carol@example.com', password: 'NewPassw0rd' }))
          .status,
        200
      );
    });
  });

  // ----------------------------------------------------------------- Teams
  describe('teams & invitations (story 11)', () => {
    test('creator becomes owner; non-members cannot view', async () => {
      const res = await api('post', '/api/teams', alice.token).send({
        name: 'Apollo',
        description: 'Moon project',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.team.role, 'owner');
      team = res.body.team;

      assert.equal((await api('get', `/api/teams/${team.id}`, carol.token)).status, 403);
      assert.equal((await api('get', '/api/teams/9999', alice.token)).status, 404);
      const list = await api('get', '/api/teams', alice.token);
      assert.equal(list.body.teams.length, 1);
    });

    test('owner invites; only owner may invite; duplicates rejected', async () => {
      const inv = await api('post', `/api/teams/${team.id}/invitations`, alice.token).send({
        email: 'BOB@example.com',
      });
      assert.equal(inv.status, 201);
      assert.equal(inv.body.invitation.status, 'pending');

      assert.equal(
        (
          await api('post', `/api/teams/${team.id}/invitations`, alice.token).send({
            email: 'bob@example.com',
          })
        ).status,
        409
      );
      assert.equal(
        (await api('post', `/api/teams/${team.id}/invitations`, carol.token).send({ email: 'x@example.com' }))
          .status,
        403
      );
    });

    test('invitee is notified, sees the invitation and joins', async () => {
      const notes = await notificationsFor(bob);
      assert.ok(notes.some((n) => n.type === 'team_invitation'));

      const pending = await api('get', '/api/invitations', bob.token);
      assert.equal(pending.body.invitations.length, 1);
      const inviteId = pending.body.invitations[0].id;

      // someone else cannot accept it (and can't tell it exists)
      assert.equal((await api('post', `/api/invitations/${inviteId}/accept`, carol.token)).status, 404);

      const accept = await api('post', `/api/invitations/${inviteId}/accept`, bob.token);
      assert.equal(accept.status, 200);
      assert.equal((await api('post', `/api/invitations/${inviteId}/accept`, bob.token)).status, 409);

      const detail = await api('get', `/api/teams/${team.id}`, bob.token);
      assert.equal(detail.body.team.members.length, 2);
      assert.ok((await notificationsFor(alice)).some((n) => n.type === 'invitation_accepted'));
    });

    test('declining works and an invitation can be re-sent', async () => {
      await api('post', `/api/teams/${team.id}/invitations`, alice.token).send({
        email: 'carol@example.com',
      });
      const [inv] = (await api('get', '/api/invitations', carol.token)).body.invitations;
      assert.equal((await api('post', `/api/invitations/${inv.id}/decline`, carol.token)).status, 204);
      assert.equal((await api('get', '/api/invitations', carol.token)).body.invitations.length, 0);
      assert.equal(
        (
          await api('post', `/api/teams/${team.id}/invitations`, alice.token).send({
            email: 'carol@example.com',
          })
        ).status,
        201
      );
    });
  });

  // ----------------------------------------------------------------- Tasks
  describe('tasks (stories 4-9)', () => {
    test('creates a task with title, description and due date; assignee is notified', async () => {
      const res = await api('post', '/api/tasks', alice.token).send({
        team_id: team.id,
        title: 'Design landing page',
        description: 'Hero section with 100% responsive layout',
        due_date: '2030-06-01',
        priority: 'high',
        assignee_id: bob.id,
      });
      assert.equal(res.status, 201);
      task = res.body.task;
      assert.equal(task.status, 'open');
      assert.equal(task.due_date, '2030-06-01T00:00:00.000Z');
      assert.equal(task.assignee.id, bob.id);
      assert.equal(task.creator.id, alice.id);

      assert.ok(
        (await notificationsFor(bob)).some((n) => n.type === 'task_assigned' && n.task_id === task.id)
      );
    });

    test('validates input and enforces team boundaries', async () => {
      const base = { team_id: team.id, title: 'T' };
      assert.equal((await api('post', '/api/tasks', alice.token).send({ ...base, title: '' })).status, 400);
      assert.equal(
        (await api('post', '/api/tasks', alice.token).send({ ...base, due_date: '2026-02-31' })).status,
        400
      );
      assert.equal(
        (await api('post', '/api/tasks', alice.token).send({ ...base, due_date: 'tomorrow' })).status,
        400
      );
      assert.equal(
        (await api('post', '/api/tasks', alice.token).send({ ...base, priority: 'urgent' })).status,
        400
      );
      // assignee outside the team
      assert.equal(
        (await api('post', '/api/tasks', alice.token).send({ ...base, assignee_id: carol.id })).status,
        400
      );
      // outsider cannot create in the team
      assert.equal((await api('post', '/api/tasks', carol.token).send(base)).status, 403);
    });

    test('lists "my" tasks, filters by status, and isolates other users', async () => {
      await api('post', '/api/tasks', alice.token).send({
        team_id: team.id,
        title: 'Write docs',
        due_date: '2020-01-01',
        assignee_id: bob.id,
      });
      await api('post', '/api/tasks', alice.token).send({
        team_id: team.id,
        title: 'Unassigned chore',
        status: 'in_progress',
      });

      const mine = await api('get', '/api/tasks?assignee=me', bob.token);
      assert.equal(mine.body.tasks.length, 2);
      assert.ok(mine.body.tasks.every((t) => t.assignee.id === bob.id));

      const open = await api('get', '/api/tasks?status=open', alice.token);
      assert.equal(open.body.pagination.total, 2);
      const multi = await api('get', '/api/tasks?status=open,in_progress', alice.token);
      assert.equal(multi.body.pagination.total, 3);
      assert.equal((await api('get', '/api/tasks?status=bogus', alice.token)).status, 400);

      const outsider = await api('get', '/api/tasks', carol.token);
      assert.deepEqual(outsider.body.tasks, []);
      assert.equal((await api('get', `/api/tasks?team_id=${team.id}`, carol.token)).status, 403);
      assert.equal((await api('get', '/api/tasks?assignee=unassigned', alice.token)).body.tasks.length, 1);
    });

    test('searches title and description, case-insensitively, treating % literally', async () => {
      const byTitle = await api('get', '/api/tasks?q=LANDING', alice.token);
      assert.equal(byTitle.body.tasks.length, 1);
      const byDesc = await api('get', '/api/tasks?q=hero', alice.token);
      assert.equal(byDesc.body.tasks.length, 1);
      const literalPct = await api('get', `/api/tasks?q=${encodeURIComponent('100%')}`, alice.token);
      assert.equal(literalPct.body.tasks.length, 1);
      const wildcardAbuse = await api('get', `/api/tasks?q=${encodeURIComponent('%')}`, alice.token);
      assert.equal(wildcardAbuse.body.tasks.length, 1); // only the task whose text contains a real "%"
      assert.equal((await api('get', '/api/tasks?q=zzzz', alice.token)).body.tasks.length, 0);
    });

    test('sorts (nulls last for due date), paginates, and finds overdue tasks', async () => {
      const asc = await api('get', '/api/tasks?sort_by=due_date&order=asc', alice.token);
      assert.deepEqual(
        asc.body.tasks.map((t) => t.title),
        ['Write docs', 'Design landing page', 'Unassigned chore']
      );
      const desc = await api('get', '/api/tasks?sort_by=due_date&order=desc', alice.token);
      assert.equal(desc.body.tasks.at(-1).title, 'Unassigned chore'); // still last

      const byPriority = await api('get', '/api/tasks?sort_by=priority&order=desc', alice.token);
      assert.equal(byPriority.body.tasks[0].priority, 'high');
      const byTitle = await api('get', '/api/tasks?sort_by=title&order=asc', alice.token);
      assert.equal(byTitle.body.tasks[0].title, 'Design landing page');
      assert.equal((await api('get', '/api/tasks?sort_by=password_hash', alice.token)).status, 400);

      const page2 = await api('get', '/api/tasks?limit=2&page=2&sort_by=due_date&order=asc', alice.token);
      assert.equal(page2.body.tasks.length, 1);
      assert.equal(page2.body.pagination.total_pages, 2);

      const overdue = await api('get', '/api/tasks?overdue=true', alice.token);
      assert.deepEqual(
        overdue.body.tasks.map((t) => t.title),
        ['Write docs']
      );
      const range = await api('get', '/api/tasks?due_before=2025-01-01', alice.token);
      assert.equal(range.body.tasks.length, 1);
    });

    test('SQL injection attempts in filters are inert', async () => {
      const res = await api(
        'get',
        `/api/tasks?q=${encodeURIComponent("'; DROP TABLE tasks; --")}`,
        alice.token
      );
      assert.equal(res.status, 200);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 3);
    });

    test('gets a single task; non-members get 403, unknown ids 404', async () => {
      assert.equal((await api('get', `/api/tasks/${task.id}`, bob.token)).status, 200);
      assert.equal((await api('get', `/api/tasks/${task.id}`, carol.token)).status, 403);
      assert.equal((await api('get', '/api/tasks/9999', alice.token)).status, 404);
      assert.equal((await api('get', '/api/tasks/abc', alice.token)).status, 400);
    });

    test('assignee marks the task completed; creator is notified; reopening clears the timestamp', async () => {
      const done = await api('post', `/api/tasks/${task.id}/complete`, bob.token);
      assert.equal(done.status, 200);
      assert.equal(done.body.task.status, 'completed');
      assert.ok(done.body.task.completed_at);
      assert.ok((await notificationsFor(alice)).some((n) => n.type === 'task_completed'));

      const reopened = await api('patch', `/api/tasks/${task.id}`, bob.token).send({ status: 'open' });
      assert.equal(reopened.body.task.completed_at, null);
    });

    test('updates fields; reassigns to another member and notifies them', async () => {
      const upd = await api('patch', `/api/tasks/${task.id}`, alice.token).send({
        title: 'Design new landing page',
        priority: 'low',
      });
      assert.equal(upd.body.task.title, 'Design new landing page');
      assert.equal(upd.body.task.priority, 'low');
      assert.equal((await api('patch', `/api/tasks/${task.id}`, alice.token).send({})).status, 400);

      const re = await api('post', `/api/tasks/${task.id}/assign`, bob.token).send({ assignee_id: alice.id });
      assert.equal(re.body.task.assignee.id, alice.id);
      assert.ok(
        (await notificationsFor(alice)).some((n) => n.type === 'task_assigned' && n.task_id === task.id)
      );

      assert.equal(
        (await api('post', `/api/tasks/${task.id}/assign`, bob.token).send({ assignee_id: carol.id })).status,
        400
      );
      const un = await api('post', `/api/tasks/${task.id}/assign`, bob.token).send({ assignee_id: null });
      assert.equal(un.body.task.assignee, null);
      await api('post', `/api/tasks/${task.id}/assign`, alice.token).send({ assignee_id: bob.id });
    });
  });

  // -------------------------------------------------------------- Comments
  describe('comments (story 10)', () => {
    let comment;

    test('team members comment; assignee/creator are notified (not the author)', async () => {
      const res = await api('post', `/api/tasks/${task.id}/comments`, alice.token).send({
        body: 'Please use the new brand colors',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.comment.author.id, alice.id);
      comment = res.body.comment;

      assert.ok((await notificationsFor(bob)).some((n) => n.type === 'comment_added'));
      assert.equal(
        (await api('post', `/api/tasks/${task.id}/comments`, alice.token).send({ body: '   ' })).status,
        400
      );
      assert.equal(
        (await api('post', `/api/tasks/${task.id}/comments`, carol.token).send({ body: 'hi' })).status,
        403
      );
    });

    test('lists, edits (author only) and deletes (author or owner)', async () => {
      await api('post', `/api/tasks/${task.id}/comments`, bob.token).send({ body: 'On it' });
      const list = await api('get', `/api/tasks/${task.id}/comments`, bob.token);
      assert.equal(list.body.comments.length, 2);
      assert.equal((await api('get', `/api/tasks/${task.id}`, bob.token)).body.task.comment_count, 2);

      assert.equal(
        (
          await api('patch', `/api/tasks/${task.id}/comments/${comment.id}`, bob.token).send({
            body: 'hacked',
          })
        ).status,
        403
      );
      const edit = await api('patch', `/api/tasks/${task.id}/comments/${comment.id}`, alice.token).send({
        body: 'Use brand colors v2',
      });
      assert.equal(edit.body.comment.body, 'Use brand colors v2');

      const bobComment = list.body.comments.find((c) => c.author.id === bob.id);
      assert.equal(
        (await api('delete', `/api/tasks/${task.id}/comments/${bobComment.id}`, alice.token)).status,
        204
      ); // owner
      assert.equal(
        (await api('delete', `/api/tasks/${task.id}/comments/${comment.id}`, bob.token)).status,
        403
      );
      assert.equal(
        (await api('delete', `/api/tasks/${task.id}/comments/${comment.id}`, alice.token)).status,
        204
      ); // author
    });
  });

  // ----------------------------------------------------------- Attachments
  describe('attachments (story 10)', () => {
    let attachment;
    const filesOnDisk = () => fs.readdirSync(process.env.UPLOAD_DIR).length;

    test('uploads a file and downloads identical bytes', async () => {
      const content = Buffer.from('quarterly numbers\n'.repeat(50));
      const res = await api('post', `/api/tasks/${task.id}/attachments`, bob.token).attach(
        'file',
        content,
        'report.txt'
      );
      assert.equal(res.status, 201);
      attachment = res.body.attachment;
      assert.equal(attachment.filename, 'report.txt');
      assert.equal(attachment.size_bytes, content.length);
      assert.ok(!JSON.stringify(res.body).includes('stored_name')); // internals not exposed

      const dl = await api('get', attachment.download_url, alice.token)
        .buffer(true)
        .parse((r, cb) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      assert.equal(dl.status, 200);
      assert.match(dl.headers['content-disposition'], /attachment/);
      assert.deepEqual(dl.body, content);
      assert.ok((await notificationsFor(alice)).some((n) => n.type === 'attachment_added'));
    });

    test('rejects blocked types, missing files and outsiders without writing to disk', async () => {
      const before = filesOnDisk();
      const exe = await api('post', `/api/tasks/${task.id}/attachments`, bob.token).attach(
        'file',
        Buffer.from('MZ'),
        'virus.exe'
      );
      assert.equal(exe.status, 400);
      assert.equal(
        (await api('post', `/api/tasks/${task.id}/attachments`, bob.token).field('x', 'y')).status,
        400
      );
      const outsider = await api('post', `/api/tasks/${task.id}/attachments`, carol.token).attach(
        'file',
        Buffer.from('hi'),
        'a.txt'
      );
      assert.equal(outsider.status, 403);
      assert.equal(filesOnDisk(), before);
      assert.equal((await api('get', attachment.download_url, carol.token)).status, 403);
    });

    test('preserves non-ASCII filenames', async () => {
      const res = await api('post', `/api/tasks/${task.id}/attachments`, bob.token).attach(
        'file',
        Buffer.from('x'),
        'résumé-日本語.pdf'
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.attachment.filename, 'résumé-日本語.pdf');
      await api('delete', `/api/tasks/${task.id}/attachments/${res.body.attachment.id}`, bob.token);
    });

    test('path-traversal filenames are harmless', async () => {
      const res = await api('post', `/api/tasks/${task.id}/attachments`, bob.token).attach(
        'file',
        Buffer.from('x'),
        '../../etc/passwd.txt'
      );
      assert.equal(res.status, 201);
      const stored = db
        .prepare('SELECT stored_name FROM attachments WHERE id = ?')
        .get(res.body.attachment.id).stored_name;
      assert.match(stored, /^[0-9a-f-]{36}\.txt$/);
      await api('delete', `/api/tasks/${task.id}/attachments/${res.body.attachment.id}`, bob.token);
    });

    test('lists attachments and deletes (uploader or owner) including the file', async () => {
      const list = await api('get', `/api/tasks/${task.id}/attachments`, alice.token);
      assert.equal(list.body.attachments.length, 1);
      assert.equal(
        (await api('delete', `/api/tasks/${task.id}/attachments/${attachment.id}`, carol.token)).status,
        403
      );
      assert.equal(
        (await api('delete', `/api/tasks/${task.id}/attachments/${attachment.id}`, alice.token)).status,
        204
      );
      await new Promise((r) => setTimeout(r, 50)); // fs.rm is fire-and-forget
      assert.equal(filesOnDisk(), 0);
      assert.equal((await api('get', attachment.download_url, alice.token)).status, 404);
    });
  });

  // --------------------------------------------------------- Notifications
  describe('notifications (story 13)', () => {
    test('history, unread count, mark one / all read, and per-user isolation', async () => {
      const res = await api('get', '/api/notifications', bob.token);
      assert.ok(res.body.unread_count > 0);
      const unread = await api('get', '/api/notifications?unread=true', bob.token);
      assert.ok(unread.body.notifications.every((n) => n.is_read === false));

      const first = res.body.notifications[0];
      assert.equal((await api('post', `/api/notifications/${first.id}/read`, alice.token)).status, 404); // not hers
      assert.equal((await api('post', `/api/notifications/${first.id}/read`, bob.token)).status, 204);

      const all = await api('post', '/api/notifications/read-all', bob.token);
      assert.equal(all.status, 200);
      assert.equal((await api('get', '/api/notifications', bob.token)).body.unread_count, 0);
    });

    test('pushes a notification in real time over Server-Sent Events', async () => {
      const server = http.createServer(app).listen(0);
      const { port } = server.address();
      let buffer = '';
      const waiters = [];
      const sse = await new Promise((resolve, reject) => {
        const req = http.get({ port, path: `/api/notifications/stream?token=${bob.token}` }, (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'], /text\/event-stream/);
          res.setEncoding('utf8');
          res.on('data', (d) => {
            buffer += d;
            waiters.forEach((w) => w());
          });
          resolve(req);
        });
        req.on('error', reject);
      });
      const waitFor = (text) =>
        new Promise((ok, fail) => {
          const timer = setTimeout(
            () => fail(new Error(`timed out waiting for "${text}"; got:\n${buffer}`)),
            3000
          );
          const check = () => {
            if (buffer.includes(text)) {
              clearTimeout(timer);
              ok();
            }
          };
          waiters.push(check);
          check();
        });

      try {
        await waitFor('event: connected');
        assert.equal(notifier.connectionCount(bob.id), 1);

        await api('patch', `/api/tasks/${task.id}`, alice.token).send({ priority: 'high' });
        await waitFor('event: notification');
        await waitFor('"type":"task_updated"');
      } finally {
        sse.destroy();
        server.close();
      }
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(notifier.connectionCount(bob.id), 0); // cleaned up on disconnect
    });

    test('stream rejects missing/invalid tokens, and ?token= is not accepted elsewhere', async () => {
      assert.equal((await api('get', '/api/notifications/stream')).status, 401);
      assert.equal((await api('get', '/api/notifications/stream?token=bad')).status, 401);
      assert.equal((await api('get', `/api/notifications?token=${bob.token}`)).status, 401);
    });
  });

  // -------------------------------------------------------------------- AI
  describe('AI assistance (story 14)', () => {
    const build = (ai) => createApp({ db, ai }).app;
    const asApp = (a) => (method, url, token) =>
      request(a)[method](url).set('Authorization', `Bearer ${token}`);

    test('falls back to a template when no API key is configured', async () => {
      const res = await api('post', '/api/ai/description', alice.token).send({
        title: 'Migrate database',
        notes: 'Postgres 16',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.source, 'template');
      assert.match(res.body.description, /Migrate database/);
      assert.equal((await api('post', '/api/ai/description', alice.token).send({})).status, 400);
      assert.equal((await api('post', '/api/ai/description').send({ title: 'x' })).status, 401);
    });

    test('calls the Anthropic Messages API when a key is set', async () => {
      let captured;
      const fakeFetch = async (url, init) => {
        captured = { url, init, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Generated by model' }] }) };
      };
      const aiApp = asApp(
        build(createAiService({ apiKey: 'sk-test', model: 'claude-haiku-5-5', fetchImpl: fakeFetch }))
      );

      const res = await aiApp('post', '/api/ai/description', alice.token).send({ title: 'Plan offsite' });
      assert.equal(res.body.source, 'ai');
      assert.equal(res.body.description, 'Generated by model');
      assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
      assert.equal(captured.init.headers['x-api-key'], 'sk-test');
      assert.equal(captured.body.model, 'claude-haiku-5-5');
      assert.match(captured.body.messages[0].content, /Plan offsite/);
    });

    test('degrades gracefully when the upstream API fails', async () => {
      const failing = async () => ({ ok: false, status: 500 });
      const aiApp = asApp(
        build(createAiService({ apiKey: 'sk-test', model: 'm', fetchImpl: failing, logger: {} }))
      );
      const res = await aiApp('post', '/api/ai/description', alice.token).send({ title: 'Plan offsite' });
      assert.equal(res.status, 200);
      assert.equal(res.body.source, 'template');
    });

    test('summarises a task with its comments; respects team access', async () => {
      await api('post', `/api/tasks/${task.id}/comments`, bob.token).send({
        body: 'Draft is ready for review',
      });
      const res = await api('post', `/api/ai/tasks/${task.id}/summary`, alice.token);
      assert.equal(res.status, 200);
      assert.match(res.body.summary, /Design new landing page/);
      assert.match(res.body.summary, /Draft is ready/);
      assert.equal((await api('post', `/api/ai/tasks/${task.id}/summary`, carol.token)).status, 403);
    });
  });

  // ------------------------------------------------- Membership & deletion
  describe('membership changes and deletion', () => {
    test('removing a member unassigns their tasks; the owner cannot be removed', async () => {
      assert.equal(
        (await api('delete', `/api/teams/${team.id}/members/${alice.id}`, alice.token)).status,
        400
      );
      assert.equal((await api('delete', `/api/teams/${team.id}/members/${bob.id}`, carol.token)).status, 403);

      const removed = await api('delete', `/api/teams/${team.id}/members/${bob.id}`, alice.token);
      assert.equal(removed.status, 204);
      assert.equal((await api('get', `/api/tasks/${task.id}`, bob.token)).status, 403); // lost access
      assert.equal((await api('get', `/api/tasks/${task.id}`, alice.token)).body.task.assignee, null);
    });

    test('a member can leave voluntarily and be re-invited', async () => {
      await api('post', `/api/teams/${team.id}/invitations`, alice.token).send({ email: 'bob@example.com' });
      const [inv] = (await api('get', '/api/invitations', bob.token)).body.invitations;
      await api('post', `/api/invitations/${inv.id}/accept`, bob.token);
      assert.equal((await api('delete', `/api/teams/${team.id}/members/${bob.id}`, bob.token)).status, 204);
    });

    test('only creator/owner delete tasks; deletion cascades to comments', async () => {
      await api('post', `/api/teams/${team.id}/invitations`, alice.token).send({ email: 'bob@example.com' });
      const [inv] = (await api('get', '/api/invitations', bob.token)).body.invitations;
      await api('post', `/api/invitations/${inv.id}/accept`, bob.token);

      const bobTask = (
        await api('post', '/api/tasks', bob.token).send({ team_id: team.id, title: 'Bob task' })
      ).body.task;
      await api('post', `/api/tasks/${bobTask.id}/comments`, bob.token).send({ body: 'note' });
      assert.equal((await api('delete', `/api/tasks/${task.id}`, bob.token)).status, 403); // not creator, not owner
      assert.equal((await api('delete', `/api/tasks/${bobTask.id}`, alice.token)).status, 204); // owner
      assert.equal((await api('get', `/api/tasks/${bobTask.id}`, alice.token)).status, 404);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM comments WHERE task_id = ?').get(bobTask.id).n, 0);
    });

    test('team owner can update and delete the team (cascade)', async () => {
      assert.equal((await api('patch', `/api/teams/${team.id}`, bob.token).send({ name: 'x' })).status, 403);
      const upd = await api('patch', `/api/teams/${team.id}`, alice.token).send({ name: 'Apollo 2' });
      assert.equal(upd.body.team.name, 'Apollo 2');

      assert.equal((await api('delete', `/api/teams/${team.id}`, bob.token)).status, 403);
      assert.equal((await api('delete', `/api/teams/${team.id}`, alice.token)).status, 204);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
    });
  });

  // ------------------------------------------------------------ Misc / HTTP
  describe('error handling', () => {
    test('malformed JSON, unknown routes and health check', async () => {
      const bad = await api('post', '/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{not json');
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.message, 'Malformed JSON body');

      const missing = await api('get', '/api/nope', alice.token);
      assert.equal(missing.status, 404);
      assert.ok(missing.body.error.message);

      assert.equal((await api('get', '/health')).body.status, 'ok');
    });
  });
});
