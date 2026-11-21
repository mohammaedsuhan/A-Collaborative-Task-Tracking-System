'use strict';

const { forbidden, notFound } = require('../utils/errors');

/**
 * Authorization helpers shared by the routers. Access is always derived from
 * team membership: you can only see or touch a task if you belong to its team.
 */
function createAccess(db) {
  const getTeam = db.prepare('SELECT * FROM teams WHERE id = ?');
  const getMembership = db.prepare(
    'SELECT * FROM team_members WHERE team_id = ? AND user_id = ?'
  );
  const getTask = db.prepare('SELECT * FROM tasks WHERE id = ?');

  /** Returns { team, membership } or throws 404/403. */
  function requireMember(teamId, userId) {
    const team = getTeam.get(teamId);
    if (!team) throw notFound('Team not found');
    const membership = getMembership.get(teamId, userId);
    if (!membership) throw forbidden('You are not a member of this team');
    return { team, membership };
  }

  /** Returns { task, team, membership } or throws 404/403. */
  function requireTaskAccess(taskId, userId) {
    const task = getTask.get(taskId);
    if (!task) throw notFound('Task not found');
    const { team, membership } = requireMember(task.team_id, userId);
    return { task, team, membership };
  }

  function isMember(teamId, userId) {
    return Boolean(getMembership.get(teamId, userId));
  }

  return { requireMember, requireTaskAccess, isMember };
}

module.exports = { createAccess };
