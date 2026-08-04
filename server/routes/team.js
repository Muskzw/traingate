'use strict';

/** Company-side administration: seats, employees, assignments, progress. */

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { wrap, bad, forbidden, notFound, hashPassword, randomToken } = require('../util');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The org the caller administers. Platform admins may pass ?org_id=. */
function targetOrg(req) {
  const id =
    req.user.role === 'platform_admin' && req.query.org_id
      ? Number(req.query.org_id)
      : req.user.org_id;
  if (!id) throw forbidden('Your account is not attached to a company.');
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
  if (!org) throw notFound('Company not found.');
  return org;
}

const seatsUsed = (orgId) =>
  db.prepare('SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND active = 1').get(orgId).n;

router.get(
  '/',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const org = targetOrg(req);
    const members = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at,
                (SELECT COUNT(*) FROM enrollments e WHERE e.user_id = u.id) AS assigned,
                (SELECT COUNT(*) FROM enrollments e WHERE e.user_id = u.id AND e.status = 'completed') AS completed
           FROM users u
          WHERE u.org_id = ?
       ORDER BY u.role = 'org_admin' DESC, u.name COLLATE NOCASE`
      )
      .all(org.id);

    res.json({
      org: { id: org.id, name: org.name, seats: org.seats, contact_email: org.contact_email },
      seats_used: seatsUsed(org.id),
      members,
    });
  })
);

/**
 * Adds an employee. Returns a one-time password for the admin to hand over —
 * there is no mail server in this deployment, so credentials are shown once.
 */
router.post(
  '/members',
  requireAuth,
  requireRole('org_admin'),
  wrap(async (req, res) => {
    const org = targetOrg(req);
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = ['learner', 'instructor', 'org_admin'].includes(req.body.role)
      ? req.body.role
      : 'learner';

    if (!name) throw bad('Name is required.');
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw bad('Someone with that email already has an account.');
    }
    if (seatsUsed(org.id) >= org.seats) {
      throw bad(`All ${org.seats} seats are in use. Increase the seat count to add more people.`);
    }

    const tempPassword = randomToken(9);
    const info = db
      .prepare(
        'INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)'
      )
      .run(org.id, email, name, hashPassword(tempPassword), role);

    res.status(201).json({
      member: { id: Number(info.lastInsertRowid), name, email, role, active: 1 },
      temporary_password: tempPassword,
    });
  })
);

router.patch(
  '/members/:id',
  requireAuth,
  requireRole('org_admin'),
  wrap(async (req, res) => {
    const org = targetOrg(req);
    const member = db
      .prepare('SELECT * FROM users WHERE id = ? AND org_id = ?')
      .get(Number(req.params.id), org.id);
    if (!member) throw notFound('That person is not in your company.');

    if (member.id === req.user.id && req.body.active === false) {
      throw bad('You cannot deactivate your own account.');
    }

    const updates = {};
    if (typeof req.body.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim();
    if (['learner', 'instructor', 'org_admin'].includes(req.body.role)) updates.role = req.body.role;
    if (typeof req.body.active === 'boolean') {
      if (req.body.active && seatsUsed(org.id) >= org.seats && !member.active) {
        throw bad('No free seats. Increase the seat count first.');
      }
      updates.active = req.body.active ? 1 : 0;
    }
    if (typeof req.body.password === 'string' && req.body.password) {
      if (req.body.password.length < 8) throw bad('Password must be at least 8 characters.');
      updates.password_hash = hashPassword(req.body.password);
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) throw bad('Nothing to update.');
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => updates[k]),
      member.id
    );

    if (updates.active === 0) db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(member.id);
    res.json({ ok: true });
  })
);

/** Seat count. In a paid deployment this is what the billing webhook would set. */
router.patch(
  '/seats',
  requireAuth,
  requireRole('org_admin'),
  wrap(async (req, res) => {
    const org = targetOrg(req);
    const seats = Number.parseInt(req.body.seats, 10);
    if (!Number.isFinite(seats) || seats < 1 || seats > 100000) throw bad('Enter a seat count between 1 and 100000.');
    const used = seatsUsed(org.id);
    if (seats < used) throw bad(`${used} seats are already in use. Deactivate people before reducing below that.`);
    db.prepare('UPDATE organizations SET seats = ? WHERE id = ?').run(seats, org.id);
    res.json({ ok: true, seats });
  })
);

/** Assign a course to one or more members (idempotent per member). */
router.post(
  '/assignments',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const org = targetOrg(req);
    const courseId = Number(req.body.course_id);
    const userIds = Array.isArray(req.body.user_ids) ? req.body.user_ids.map(Number) : [];
    if (!courseId) throw bad('Pick a course.');
    if (userIds.length === 0) throw bad('Pick at least one person.');

    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
    if (!course) throw notFound('Course not found.');
    if (course.status !== 'published') throw bad('Publish the course before assigning it.');
    if (course.org_id != null && course.org_id !== org.id) throw forbidden('That course belongs to another company.');

    const members = db
      .prepare(
        `SELECT id FROM users WHERE org_id = ? AND active = 1 AND id IN (${userIds.map(() => '?').join(',')})`
      )
      .all(org.id, ...userIds);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO enrollments (course_id, user_id, assigned_by) VALUES (?, ?, ?)`
    );
    const assigned = db.transaction(() =>
      members.reduce((n, m) => n + insert.run(courseId, m.id, req.user.id).changes, 0)
    )();

    res.json({ ok: true, assigned, skipped: members.length - assigned });
  })
);

router.delete(
  '/assignments/:enrollmentId',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const org = targetOrg(req);
    const row = db
      .prepare(
        `SELECT e.* FROM enrollments e JOIN users u ON u.id = e.user_id
          WHERE e.id = ? AND u.org_id = ?`
      )
      .get(Number(req.params.enrollmentId), org.id);
    if (!row) throw notFound('Assignment not found.');
    if (row.status === 'completed') throw bad('Completed training cannot be unassigned — it is part of the compliance record.');
    db.prepare('DELETE FROM enrollments WHERE id = ?').run(row.id);
    res.json({ ok: true });
  })
);

/** Company-wide progress report: one row per assignment. */
router.get(
  '/progress',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const org = targetOrg(req);
    const courseFilter = req.query.course_id ? Number(req.query.course_id) : null;

    const rows = db
      .prepare(
        `SELECT e.id AS enrollment_id, e.status, e.started_at, e.completed_at, e.final_score,
                u.id AS user_id, u.name AS user_name, u.email,
                c.id AS course_id, c.title AS course_title,
                (SELECT COUNT(*) FROM sections s WHERE s.course_id = c.id) AS total_sections,
                (SELECT COUNT(*) FROM section_progress sp
                   JOIN sections s2 ON s2.id = sp.section_id
                  WHERE sp.enrollment_id = e.id AND sp.passed_at IS NOT NULL) AS passed_sections,
                (SELECT cert.code FROM certificates cert WHERE cert.enrollment_id = e.id) AS certificate_code
           FROM enrollments e
           JOIN users u ON u.id = e.user_id
           JOIN courses c ON c.id = e.course_id
          WHERE u.org_id = ? ${courseFilter ? 'AND c.id = ?' : ''}
       ORDER BY c.title, u.name COLLATE NOCASE`
      )
      .all(...(courseFilter ? [org.id, courseFilter] : [org.id]));

    res.json({ rows });
  })
);

module.exports = router;
