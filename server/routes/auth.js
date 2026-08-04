'use strict';

const express = require('express');
const db = require('../db');
const { issueToken, revokeToken, requireAuth, publicUser } = require('../auth');
const { wrap, bad, unauthorized, hashPassword, verifyPassword } = require('../util');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Self-serve signup creates a company and makes the signer-up its admin.
 * Employees are added by that admin (see routes/team.js), not here.
 */
router.post(
  '/register',
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const orgName = String(req.body.org_name || '').trim();

    if (!name) throw bad('Your name is required.');
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    if (password.length < 8) throw bad('Password must be at least 8 characters.');
    if (!orgName) throw bad('Company name is required.');

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw bad('An account with that email already exists.');
    }

    const created = db.transaction(() => {
      const org = db
        .prepare('INSERT INTO organizations (name, seats, contact_email) VALUES (?, ?, ?)')
        .run(orgName, 5, email);
      const user = db
        .prepare(
          `INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, 'org_admin')`
        )
        .run(Number(org.lastInsertRowid), email, name, hashPassword(password));
      return Number(user.lastInsertRowid);
    })();

    const token = issueToken(created);
    const user = db
      .prepare(
        `SELECT u.*, o.name AS org_name, o.seats AS org_seats
           FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.id = ?`
      )
      .get(created);
    res.status(201).json({ token, user: publicUser(user) });
  })
);

router.post(
  '/login',
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const user = db
      .prepare(
        `SELECT u.*, o.name AS org_name, o.seats AS org_seats
           FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.email = ?`
      )
      .get(email);

    // Same message either way — don't leak which emails exist.
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw unauthorized('Email or password is incorrect.');
    }
    if (!user.active) throw unauthorized('This account has been deactivated.');

    res.json({ token: issueToken(user.id), user: publicUser(user) });
  })
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    if (req.token) revokeToken(req.token);
    res.json({ ok: true });
  })
);

router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  })
);

router.post(
  '/password',
  requireAuth,
  wrap(async (req, res) => {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    if (next.length < 8) throw bad('New password must be at least 8 characters.');
    if (!verifyPassword(current, req.user.password_hash)) throw bad('Current password is incorrect.');

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true, token: issueToken(req.user.id) });
  })
);

module.exports = router;
