'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const { id, idParam } = require('../utils/schemas');

const createTeamSchema = z.object({
  name: z.string().trim().min(1, 'Team name is required').max(100),
  description: z.string().trim().max(1000).optional(),
});
const updateTeamSchema = createTeamSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
const inviteSchema = z.object({
  email: z.email('Invalid email address').transform((e) => e.toLowerCase()),
});
const memberParams = z.object({ id, userId: id });

/**
 * Teams (a.k.a. projects), membership and invitations.
 * Returns two routers: one mounted at /api/teams, one at /api/invitations.
 */
function createTeamsRouters(db, authenticate, access, notifier) {
  const teams = express.Router();
  const invitations = express.Router();
  teams.use(authenticate);
  invitations.use(authenticate);

  const insertTeam = db.prepare(
    'INSERT INTO teams (name, description, owner_id) VALUES (@name, @description, @ownerId)'
  );
  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)'
  );
  const listTeams = db.prepare(
    `SELECT t.*, tm.role,
            (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count
       FROM teams t JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ? ORDER BY t.created_at DESC, t.id DESC`
  );
  const listMembers = db.prepare(
    `SELECT u.id, u.name, u.email, tm.role, tm.joined_at
       FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ? ORDER BY tm.joined_at, u.id`
  );
  const findUserByEmail = db.prepare('SELECT id FROM users WHERE email = ?');
  const isMemberByEmail = db.prepare(
    `SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ? AND u.email = ?`
  );
  const findInvite = db.prepare('SELECT * FROM team_invitations WHERE team_id = ? AND email = ?');
  const insertInvite = db.prepare(
    'INSERT INTO team_invitations (team_id, email, invited_by) VALUES (?, ?, ?)'
  );
  const resetInvite = db.prepare(
    "UPDATE team_invitations SET status = 'pending', invited_by = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  );
  const unassignTasks = db.prepare(
    "UPDATE tasks SET assignee_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE team_id = ? AND assignee_id = ?"
  );
  const removeMember = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?');

  const requireOwner = (membership) => {
    if (membership.role !== 'owner') throw forbidden('Only the team owner can do this');
  };

  // ---- Teams ---------------------------------------------------------------

  // User story 11: create a team/project (creator becomes owner)
  teams.post('/', validate({ body: createTeamSchema }), (req, res) => {
    const { name, description = null } = req.valid.body;
    const create = db.transaction(() => {
      const { lastInsertRowid } = insertTeam.run({ name, description, ownerId: req.user.id });
      insertMember.run(lastInsertRowid, req.user.id, 'owner');
      return lastInsertRowid;
    });
    const teamId = create();
    const team = access.requireMember(teamId, req.user.id).team;
    res.status(201).json({ team: { ...team, role: 'owner', member_count: 1 } });
  });

  teams.get('/', (req, res) => {
    res.json({ teams: listTeams.all(req.user.id) });
  });

  teams.get('/:id', validate({ params: idParam }), (req, res) => {
    const { team, membership } = access.requireMember(req.valid.params.id, req.user.id);
    res.json({ team: { ...team, role: membership.role, members: listMembers.all(team.id) } });
  });

  teams.patch('/:id', validate({ params: idParam, body: updateTeamSchema }), (req, res) => {
    const { team, membership } = access.requireMember(req.valid.params.id, req.user.id);
    requireOwner(membership);

    const changes = req.valid.body;
    const assignments = Object.keys(changes)
      .map((c) => `${c} = @${c}`)
      .join(', ');
    db.prepare(`UPDATE teams SET ${assignments} WHERE id = @id`).run({ ...changes, id: team.id });
    res.json({ team: access.requireMember(team.id, req.user.id).team });
  });

  teams.delete('/:id', validate({ params: idParam }), (req, res) => {
    const { team, membership } = access.requireMember(req.valid.params.id, req.user.id);
    requireOwner(membership);
    db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
    res.status(204).end();
  });

  // ---- Members -------------------------------------------------------------

  // Owner removes a member, or a member removes themselves (leaves the team).
  teams.delete('/:id/members/:userId', validate({ params: memberParams }), (req, res) => {
    const { id: teamId, userId } = req.valid.params;
    const { team, membership } = access.requireMember(teamId, req.user.id);

    if (userId !== req.user.id) requireOwner(membership);
    if (userId === team.owner_id)
      throw badRequest('The team owner cannot be removed; delete the team instead');
    if (!access.isMember(teamId, userId)) throw notFound('That user is not a member of this team');

    db.transaction(() => {
      unassignTasks.run(teamId, userId);
      removeMember.run(teamId, userId);
    })();
    res.status(204).end();
  });

  // ---- Invitations (owner side) -------------------------------------------

  teams.post('/:id/invitations', validate({ params: idParam, body: inviteSchema }), (req, res) => {
    const { team, membership } = access.requireMember(req.valid.params.id, req.user.id);
    requireOwner(membership);
    const { email } = req.valid.body;

    if (isMemberByEmail.get(team.id, email)) throw conflict('That user is already a team member');

    const existing = findInvite.get(team.id, email);
    if (existing?.status === 'pending') throw conflict('An invitation is already pending for this email');

    let inviteId;
    if (existing) {
      resetInvite.run(req.user.id, existing.id); // re-invite after decline / leaving
      inviteId = existing.id;
    } else {
      inviteId = insertInvite.run(team.id, email, req.user.id).lastInsertRowid;
    }

    const invitee = findUserByEmail.get(email);
    if (invitee) {
      notifier.notify({
        userId: invitee.id,
        actorId: req.user.id,
        type: 'team_invitation',
        message: `${req.user.name} invited you to join "${team.name}"`,
        teamId: team.id,
      });
    }

    const invitation = db.prepare('SELECT * FROM team_invitations WHERE id = ?').get(inviteId);
    res.status(201).json({ invitation });
  });

  teams.get('/:id/invitations', validate({ params: idParam }), (req, res) => {
    const { team, membership } = access.requireMember(req.valid.params.id, req.user.id);
    requireOwner(membership);
    const rows = db
      .prepare('SELECT * FROM team_invitations WHERE team_id = ? ORDER BY created_at DESC, id DESC')
      .all(team.id);
    res.json({ invitations: rows });
  });

  // ---- Invitations (invitee side) -----------------------------------------

  // Pending invitations addressed to the logged-in user's email.
  invitations.get('/', (req, res) => {
    const rows = db
      .prepare(
        `SELECT i.id, i.team_id, t.name AS team_name, t.description AS team_description,
                u.name AS invited_by_name, i.status, i.created_at
           FROM team_invitations i
           JOIN teams t ON t.id = i.team_id
           JOIN users u ON u.id = i.invited_by
          WHERE i.email = ? AND i.status = 'pending'
          ORDER BY i.created_at DESC, i.id DESC`
      )
      .all(req.user.email);
    res.json({ invitations: rows });
  });

  /** Load a pending invitation addressed to the current user, or throw. */
  function ownPendingInvite(req) {
    const invite = db.prepare('SELECT * FROM team_invitations WHERE id = ?').get(req.valid.params.id);
    // Same 404 whether it doesn't exist or isn't yours, so ids can't be probed.
    if (!invite || invite.email.toLowerCase() !== req.user.email.toLowerCase()) {
      throw notFound('Invitation not found');
    }
    if (invite.status !== 'pending') throw conflict(`Invitation was already ${invite.status}`);
    return invite;
  }

  // User story 11: join a team by accepting an invitation
  invitations.post('/:id/accept', validate({ params: idParam }), (req, res) => {
    const invite = ownPendingInvite(req);
    db.transaction(() => {
      insertMember.run(invite.team_id, req.user.id, 'member');
      db.prepare("UPDATE team_invitations SET status = 'accepted' WHERE id = ?").run(invite.id);
    })();

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(invite.team_id);
    notifier.notify({
      userId: invite.invited_by,
      actorId: req.user.id,
      type: 'invitation_accepted',
      message: `${req.user.name} joined "${team.name}"`,
      teamId: team.id,
    });
    res.json({ team: { ...team, role: 'member' } });
  });

  invitations.post('/:id/decline', validate({ params: idParam }), (req, res) => {
    const invite = ownPendingInvite(req);
    db.prepare("UPDATE team_invitations SET status = 'declined' WHERE id = ?").run(invite.id);
    res.status(204).end();
  });

  return { teams, invitations };
}

module.exports = { createTeamsRouters };
