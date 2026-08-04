'use strict';

const db = require('./db');
const { randomToken, unauthorized, forbidden } = require('./util');

const TOKEN_TTL_DAYS = 30;

function issueToken(userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expires
  );
  return token;
}

function revokeToken(token) {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
}

function userForToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, o.name AS org_name, o.seats AS org_seats, t.expires_at
         FROM auth_tokens t
         JOIN users u ON u.id = t.user_id
    LEFT JOIN organizations o ON o.id = u.org_id
        WHERE t.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    revokeToken(token);
    return null;
  }
  if (!row.active) return null;
  return row;
}

/** Populates req.user when a valid bearer token is present. Never rejects. */
function attachUser(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  req.token = token;
  req.user = userForToken(token);
  next();
}

const requireAuth = (req, _res, next) => (req.user ? next() : next(unauthorized()));

/** requireRole('org_admin', 'instructor') — platform_admin always passes. */
const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'platform_admin' || roles.includes(req.user.role)) return next();
    return next(forbidden(`Requires role: ${roles.join(' or ')}`));
  };

/** True when the user may author/administer the given course. */
function canManageCourse(user, course) {
  if (!user || !course) return false;
  if (user.role === 'platform_admin') return true;
  if (course.owner_id === user.id) return true;
  return user.role === 'org_admin' && course.org_id != null && course.org_id === user.org_id;
}

const publicUser = (u) =>
  u && {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    org_id: u.org_id,
    org_name: u.org_name ?? null,
    org_seats: u.org_seats ?? null,
  };

module.exports = {
  issueToken,
  revokeToken,
  attachUser,
  requireAuth,
  requireRole,
  canManageCourse,
  publicUser,
};
