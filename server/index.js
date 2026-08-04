'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const db = require('./db');
const jobs = require('./jobs');
const { attachUser } = require('./auth');
const { hashPassword, HttpError } = require('./util');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(attachUser);

// API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/team', require('./routes/team'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/learn', require('./routes/learn'));
app.use('/', require('./routes/certificates')); // /c/:code and /api/certificates/:code

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ai_configured: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    // Lets the landing page offer one-click demo sign-in only when seeded.
    demo: Boolean(db.prepare(`SELECT 1 FROM users WHERE email = 'learner@demo.test'`).get()),
  });
});

// Static SPA
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Anything not an API route falls through to the SPA shell.
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Errors
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is larger than the 40 MB limit.' });
  }
  if (err && err.message && /Unsupported file type/.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/** Creates the bootstrap platform administrator on first boot. */
function seedPlatformAdmin() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return;

  db.prepare(
    `INSERT INTO users (org_id, email, name, password_hash, role) VALUES (NULL, ?, ?, ?, 'platform_admin')`
  ).run(email, 'Platform Admin', hashPassword(password));
  console.log(`[seed] Created platform admin: ${email}`);
}

seedPlatformAdmin();

// Free hosting tiers have an ephemeral disk: the database is wiped on every
// deploy and restart. Re-seeding on boot means the public demo always comes
// back up with a working course instead of an empty database. Idempotent.
if (process.env.SEED_DEMO === 'true') {
  try {
    require('../scripts/seed')();
  } catch (err) {
    console.error('[seed] Demo seed failed:', err.message);
  }
}

const reaped = jobs.reapStaleJobs();
if (reaped > 0) console.log(`[jobs] Marked ${reaped} interrupted job(s) as failed.`);

app.listen(PORT, () => {
  console.log(`\n  TrainGate running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  ⚠  ANTHROPIC_API_KEY is not set — course generation will fail until you add it to .env\n');
  } else {
    console.log(`  AI model: ${process.env.ANTHROPIC_MODEL || 'claude-opus-5'}\n`);
  }
});
