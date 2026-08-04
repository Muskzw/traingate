'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || './data/traingate.db';
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new Database(path.resolve(DB_PATH));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  seats         INTEGER NOT NULL DEFAULT 5,
  contact_email TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  -- platform_admin | org_admin | instructor | learner
  role          TEXT    NOT NULL DEFAULT 'learner',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title                 TEXT    NOT NULL,
  description           TEXT    NOT NULL DEFAULT '',
  source_filename       TEXT,
  -- draft | generating | ready | published | failed
  status                TEXT    NOT NULL DEFAULT 'draft',
  pass_threshold        INTEGER NOT NULL DEFAULT 80,
  max_attempts          INTEGER NOT NULL DEFAULT 0,      -- 0 = unlimited
  retry_cooldown_sec    INTEGER NOT NULL DEFAULT 0,
  require_final_exam    INTEGER NOT NULL DEFAULT 0,
  final_pass_threshold  INTEGER NOT NULL DEFAULT 80,
  final_exam_questions  INTEGER NOT NULL DEFAULT 15,
  questions_per_section INTEGER NOT NULL DEFAULT 4,
  shuffle_questions     INTEGER NOT NULL DEFAULT 1,
  certificate_enabled   INTEGER NOT NULL DEFAULT 1,
  open_enrollment       INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  summary     TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  video_url   TEXT,
  min_seconds INTEGER NOT NULL DEFAULT 60,
  source_ref  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sections_course ON sections(course_id, position);

CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  section_id  INTEGER REFERENCES sections(id) ON DELETE CASCADE,  -- NULL = final exam
  position    INTEGER NOT NULL,
  -- single_choice | multiple_choice | true_false
  type        TEXT    NOT NULL DEFAULT 'single_choice',
  prompt      TEXT    NOT NULL,
  options     TEXT    NOT NULL,   -- JSON array of strings
  correct     TEXT    NOT NULL,   -- JSON array of option indices
  explanation TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_questions_course ON questions(course_id, section_id, position);

CREATE TABLE IF NOT EXISTS enrollments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- assigned | in_progress | completed
  status        TEXT    NOT NULL DEFAULT 'assigned',
  assigned_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at    TEXT,
  completed_at  TEXT,
  final_score   REAL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_id, user_id)
);

CREATE TABLE IF NOT EXISTS section_progress (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  section_id    INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  seconds_spent INTEGER NOT NULL DEFAULT 0,
  content_done  INTEGER NOT NULL DEFAULT 0,
  passed_at     TEXT,
  best_score    REAL    NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_attempt  TEXT,
  UNIQUE(enrollment_id, section_id)
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  section_id    INTEGER REFERENCES sections(id) ON DELETE CASCADE, -- NULL = final exam
  attempt_no    INTEGER NOT NULL,
  score         REAL    NOT NULL,
  passed        INTEGER NOT NULL,
  detail        TEXT    NOT NULL,   -- JSON: per-question result
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS certificates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  learner_name  TEXT    NOT NULL,
  course_title  TEXT    NOT NULL,
  org_name      TEXT,
  score         REAL,
  issued_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  -- queued | running | done | failed
  status     TEXT    NOT NULL DEFAULT 'queued',
  stage      TEXT    NOT NULL DEFAULT 'queued',
  progress   INTEGER NOT NULL DEFAULT 0,
  message    TEXT    NOT NULL DEFAULT '',
  error      TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
