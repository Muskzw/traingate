'use strict';

/**
 * The learner side, including the gate:
 *
 *   read section -> dwell time met -> pass quiz -> next section unlocks
 *   ... all sections passed -> final exam (if enabled) -> certificate
 *
 * Every unlock decision is made here on the server. The browser is told what
 * is locked, but it is never trusted to decide it.
 */

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { wrap, bad, forbidden, notFound, certificateCode } = require('../util');

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */

function loadEnrollment(req) {
  const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(req.params.enrollmentId));
  if (!e) throw notFound('Enrollment not found.');
  if (e.user_id !== req.user.id && req.user.role !== 'platform_admin') {
    throw forbidden('This training is assigned to someone else.');
  }
  return e;
}

const progressRow = db.prepare(
  'SELECT * FROM section_progress WHERE enrollment_id = ? AND section_id = ?'
);

function ensureProgress(enrollmentId, sectionId) {
  let row = progressRow.get(enrollmentId, sectionId);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO section_progress (enrollment_id, section_id) VALUES (?, ?)').run(
      enrollmentId,
      sectionId
    );
    row = progressRow.get(enrollmentId, sectionId);
  }
  return row;
}

/**
 * Full server-side view of where a learner stands. Returns per-section flags
 * (locked / content_done / passed) plus whether the final exam is available.
 */
function buildState(enrollment) {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(enrollment.course_id);
  const sections = db
    .prepare('SELECT * FROM sections WHERE course_id = ? ORDER BY position')
    .all(course.id);

  let previousPassed = true; // first section is always open
  const shaped = sections.map((s) => {
    const p = ensureProgress(enrollment.id, s.id);
    const questionCount = db
      .prepare('SELECT COUNT(*) AS n FROM questions WHERE section_id = ?')
      .get(s.id).n;

    const locked = !previousPassed;
    const dwellMet = p.seconds_spent >= s.min_seconds;
    const passed = p.passed_at != null;

    const attemptsLeft =
      course.max_attempts === 0 ? null : Math.max(0, course.max_attempts - p.attempts);
    const cooldownUntil =
      p.last_attempt && course.retry_cooldown_sec > 0
        ? new Date(new Date(p.last_attempt.replace(' ', 'T') + 'Z').getTime() + course.retry_cooldown_sec * 1000)
        : null;
    const cooldownRemaining =
      cooldownUntil && !passed ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)) : 0;

    const row = {
      id: s.id,
      position: s.position,
      title: s.title,
      summary: s.summary,
      video_url: s.video_url,
      min_seconds: s.min_seconds,
      source_ref: s.source_ref,
      question_count: questionCount,
      locked,
      seconds_spent: p.seconds_spent,
      content_done: dwellMet,
      passed,
      best_score: p.best_score,
      attempts: p.attempts,
      attempts_left: attemptsLeft,
      cooldown_remaining: cooldownRemaining,
      quiz_available: !locked && dwellMet && !passed && (attemptsLeft === null || attemptsLeft > 0) && cooldownRemaining === 0,
      exhausted: attemptsLeft === 0 && !passed,
    };

    previousPassed = passed;
    return row;
  });

  const allPassed = shaped.length > 0 && shaped.every((s) => s.passed);

  // Final exam state.
  const finalCount = db
    .prepare('SELECT COUNT(*) AS n FROM questions WHERE course_id = ? AND section_id IS NULL')
    .get(course.id).n;
  const finalAttempts = db
    .prepare('SELECT * FROM quiz_attempts WHERE enrollment_id = ? AND section_id IS NULL ORDER BY id DESC')
    .all(enrollment.id);
  const finalPassed = finalAttempts.some((a) => a.passed);
  const finalAttemptsLeft =
    course.max_attempts === 0 ? null : Math.max(0, course.max_attempts - finalAttempts.length);
  const lastFinal = finalAttempts[0];
  const finalCooldown =
    lastFinal && course.retry_cooldown_sec > 0 && !finalPassed
      ? Math.max(
          0,
          Math.ceil(
            (new Date(lastFinal.created_at.replace(' ', 'T') + 'Z').getTime() +
              course.retry_cooldown_sec * 1000 -
              Date.now()) /
              1000
          )
        )
      : 0;

  const finalExam = {
    required: !!course.require_final_exam,
    question_count: finalCount,
    unlocked: !!course.require_final_exam && allPassed,
    passed: finalPassed,
    best_score: finalAttempts.reduce((m, a) => Math.max(m, a.score), 0),
    attempts: finalAttempts.length,
    attempts_left: finalAttemptsLeft,
    cooldown_remaining: finalCooldown,
    available:
      !!course.require_final_exam &&
      allPassed &&
      !finalPassed &&
      (finalAttemptsLeft === null || finalAttemptsLeft > 0) &&
      finalCooldown === 0,
  };

  const complete = allPassed && (!course.require_final_exam || finalPassed);
  const certificate = db
    .prepare('SELECT code, issued_at FROM certificates WHERE enrollment_id = ?')
    .get(enrollment.id);

  return { course, sections: shaped, final_exam: finalExam, complete, certificate: certificate || null };
}

/** Marks the enrollment complete and issues a certificate, once. */
function finalizeIfComplete(enrollment) {
  const state = buildState(enrollment);
  if (!state.complete) return state;

  if (enrollment.status !== 'completed') {
    const sectionAvg =
      state.sections.reduce((sum, s) => sum + s.best_score, 0) / (state.sections.length || 1);
    const score = state.final_exam.required ? state.final_exam.best_score : sectionAvg;

    db.prepare(
      `UPDATE enrollments SET status = 'completed', completed_at = datetime('now'), final_score = ? WHERE id = ?`
    ).run(Math.round(score * 10) / 10, enrollment.id);
  }

  if (state.course.certificate_enabled && !state.certificate) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(enrollment.user_id);
    const org = user.org_id
      ? db.prepare('SELECT name FROM organizations WHERE id = ?').get(user.org_id)
      : null;
    const updated = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollment.id);

    // Retry on the astronomically unlikely code collision.
    for (let i = 0; i < 5; i++) {
      try {
        db.prepare(
          `INSERT INTO certificates (code, enrollment_id, learner_name, course_title, org_name, score)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(certificateCode(), enrollment.id, user.name, state.course.title, org?.name ?? null, updated.final_score);
        break;
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err;
      }
    }
  }

  return buildState(db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollment.id));
}

const shuffled = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Grades a submission. All-or-nothing per question; no partial credit. */
function grade(questions, answers) {
  const detail = questions.map((q) => {
    const correct = JSON.parse(q.correct).sort((a, b) => a - b);
    const given = [...new Set((answers[String(q.id)] || []).map(Number))].sort((a, b) => a - b);
    const isCorrect =
      given.length === correct.length && given.every((v, i) => v === correct[i]);
    return {
      question_id: q.id,
      prompt: q.prompt,
      options: JSON.parse(q.options),
      given,
      correct,
      is_correct: isCorrect,
      explanation: q.explanation,
    };
  });
  const right = detail.filter((d) => d.is_correct).length;
  return { detail, score: questions.length ? (right / questions.length) * 100 : 0, right };
}

/* ------------------------------- routes ------------------------------ */

/** Everything assigned to me, plus anything I can self-enroll in. */
router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const enrollments = db
      .prepare(
        `SELECT e.*, c.title, c.description, c.require_final_exam, c.certificate_enabled,
                (SELECT COUNT(*) FROM sections s WHERE s.course_id = c.id) AS total_sections,
                (SELECT COUNT(*) FROM section_progress sp
                   JOIN sections s2 ON s2.id = sp.section_id AND s2.course_id = c.id
                  WHERE sp.enrollment_id = e.id AND sp.passed_at IS NOT NULL) AS passed_sections,
                (SELECT code FROM certificates cert WHERE cert.enrollment_id = e.id) AS certificate_code
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
          WHERE e.user_id = ?
       ORDER BY e.status = 'completed', e.created_at DESC`
      )
      .all(req.user.id);

    const available = db
      .prepare(
        `SELECT c.id, c.title, c.description
           FROM courses c
          WHERE c.status = 'published' AND c.open_enrollment = 1
            AND (c.org_id IS ? OR c.org_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.user_id = ?)`
      )
      .all(req.user.org_id ?? null, req.user.id);

    res.json({ enrollments, available });
  })
);

router.post(
  '/enroll',
  requireAuth,
  wrap(async (req, res) => {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(req.body.course_id));
    if (!course) throw notFound('Course not found.');
    if (course.status !== 'published') throw bad('That course is not published.');
    if (!course.open_enrollment) throw forbidden('This course is assigned by your administrator.');
    if (course.org_id != null && course.org_id !== req.user.org_id) {
      throw forbidden('That course belongs to another company.');
    }
    db.prepare('INSERT OR IGNORE INTO enrollments (course_id, user_id) VALUES (?, ?)').run(
      course.id,
      req.user.id
    );
    const e = db
      .prepare('SELECT * FROM enrollments WHERE course_id = ? AND user_id = ?')
      .get(course.id, req.user.id);
    res.status(201).json({ enrollment_id: e.id });
  })
);

router.get(
  '/:enrollmentId',
  requireAuth,
  wrap(async (req, res) => {
    const enrollment = loadEnrollment(req);
    if (!enrollment.started_at) {
      db.prepare(
        `UPDATE enrollments SET started_at = datetime('now'), status = 'in_progress' WHERE id = ?`
      ).run(enrollment.id);
    }
    res.json(buildState(db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollment.id)));
  })
);

/** Full reading content for one section — refused while the section is locked. */
router.get(
  '/:enrollmentId/sections/:sectionId',
  requireAuth,
  wrap(async (req, res) => {
    const enrollment = loadEnrollment(req);
    const state = buildState(enrollment);
    const meta = state.sections.find((s) => s.id === Number(req.params.sectionId));
    if (!meta) throw notFound('Section not found.');
    if (meta.locked) throw forbidden('Finish the previous section first.');

    const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(meta.id);
    res.json({ section: { ...section, ...meta } });
  })
);

/**
 * Dwell tracking. The client reports elapsed seconds; each call can add at
 * most 30s so a tab left open (or a scripted flood) cannot fast-forward.
 */
router.post(
  '/:enrollmentId/heartbeat',
  requireAuth,
  wrap(async (req, res) => {
    const enrollment = loadEnrollment(req);
    const sectionId = Number(req.body.section_id);
    const section = db
      .prepare('SELECT * FROM sections WHERE id = ? AND course_id = ?')
      .get(sectionId, enrollment.course_id);
    if (!section) throw notFound('Section not found.');

    const state = buildState(enrollment);
    const meta = state.sections.find((s) => s.id === sectionId);
    if (meta.locked) throw forbidden('That section is locked.');

    const add = Math.min(30, Math.max(0, Number(req.body.seconds) || 0));
    db.prepare(
      'UPDATE section_progress SET seconds_spent = seconds_spent + ?, content_done = CASE WHEN seconds_spent + ? >= ? THEN 1 ELSE content_done END WHERE enrollment_id = ? AND section_id = ?'
    ).run(add, add, section.min_seconds, enrollment.id, sectionId);

    const p = progressRow.get(enrollment.id, sectionId);
    res.json({
      seconds_spent: p.seconds_spent,
      required: section.min_seconds,
      content_done: p.seconds_spent >= section.min_seconds,
    });
  })
);

/** Serves quiz questions without answers. Enforces gate, attempts, cooldown. */
function serveQuiz(req, res, { isFinal }) {
  const enrollment = loadEnrollment(req);
  const state = buildState(enrollment);
  const course = state.course;

  let questions;
  if (isFinal) {
    const f = state.final_exam;
    if (!f.required) throw bad('This course has no final exam.');
    if (!f.unlocked) throw forbidden('Pass every section before taking the final exam.');
    if (f.passed) throw bad('You have already passed the final exam.');
    if (f.attempts_left === 0) throw forbidden('No attempts remaining. Contact your administrator.');
    if (f.cooldown_remaining > 0) throw forbidden(`Try again in ${f.cooldown_remaining} seconds.`);
    questions = db
      .prepare('SELECT * FROM questions WHERE course_id = ? AND section_id IS NULL ORDER BY position')
      .all(course.id);
  } else {
    const meta = state.sections.find((s) => s.id === Number(req.params.sectionId));
    if (!meta) throw notFound('Section not found.');
    if (meta.locked) throw forbidden('Finish the previous section first.');
    if (!meta.content_done) {
      throw forbidden(
        `Spend at least ${meta.min_seconds} seconds with this section before the quiz unlocks (${meta.seconds_spent}s so far).`
      );
    }
    if (meta.passed) throw bad('You have already passed this quiz.');
    if (meta.attempts_left === 0) throw forbidden('No attempts remaining. Contact your administrator.');
    if (meta.cooldown_remaining > 0) throw forbidden(`Try again in ${meta.cooldown_remaining} seconds.`);
    questions = db
      .prepare('SELECT * FROM questions WHERE section_id = ? ORDER BY position')
      .all(meta.id);
  }

  if (questions.length === 0) throw bad('This quiz has no questions yet.');
  const ordered = course.shuffle_questions ? shuffled(questions) : questions;

  res.json({
    pass_threshold: isFinal ? course.final_pass_threshold : course.pass_threshold,
    questions: ordered.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: JSON.parse(q.options),
    })),
  });
}

/** Grades a submission, records the attempt, and re-evaluates the gate. */
function submitQuiz(req, res, { isFinal }) {
  const enrollment = loadEnrollment(req);
  const state = buildState(enrollment);
  const course = state.course;
  const answers = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {};

  let questions;
  let sectionId = null;
  let threshold;

  if (isFinal) {
    const f = state.final_exam;
    if (!f.available) throw forbidden('The final exam is not available right now.');
    questions = db
      .prepare('SELECT * FROM questions WHERE course_id = ? AND section_id IS NULL ORDER BY position')
      .all(course.id);
    threshold = course.final_pass_threshold;
  } else {
    const meta = state.sections.find((s) => s.id === Number(req.params.sectionId));
    if (!meta) throw notFound('Section not found.');
    if (!meta.quiz_available) throw forbidden('This quiz is not available right now.');
    sectionId = meta.id;
    questions = db.prepare('SELECT * FROM questions WHERE section_id = ? ORDER BY position').all(meta.id);
    threshold = course.pass_threshold;
  }

  const { detail, score, right } = grade(questions, answers);
  const passed = score >= threshold;

  const attemptNo =
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM quiz_attempts WHERE enrollment_id = ? AND section_id IS ?'
      )
      .get(enrollment.id, sectionId).n + 1;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO quiz_attempts (enrollment_id, section_id, attempt_no, score, passed, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(enrollment.id, sectionId, attemptNo, score, passed ? 1 : 0, JSON.stringify(detail));

    if (!isFinal) {
      db.prepare(
        `UPDATE section_progress
            SET attempts = attempts + 1,
                last_attempt = datetime('now'),
                best_score = MAX(best_score, ?),
                passed_at = CASE WHEN ? = 1 AND passed_at IS NULL THEN datetime('now') ELSE passed_at END
          WHERE enrollment_id = ? AND section_id = ?`
      ).run(score, passed ? 1 : 0, enrollment.id, sectionId);
    }

    if (enrollment.status === 'assigned') {
      db.prepare(`UPDATE enrollments SET status = 'in_progress' WHERE id = ?`).run(enrollment.id);
    }
  })();

  const after = finalizeIfComplete(
    db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollment.id)
  );

  res.json({
    passed,
    score: Math.round(score * 10) / 10,
    correct: right,
    total: questions.length,
    pass_threshold: threshold,
    // Feedback is shown after grading so a failed attempt is a teaching moment.
    detail,
    state: after,
  });
}

router.get('/:enrollmentId/quiz/:sectionId', requireAuth, wrap(async (req, res) => serveQuiz(req, res, { isFinal: false })));
router.post('/:enrollmentId/quiz/:sectionId', requireAuth, wrap(async (req, res) => submitQuiz(req, res, { isFinal: false })));
router.get('/:enrollmentId/final-exam', requireAuth, wrap(async (req, res) => serveQuiz(req, res, { isFinal: true })));
router.post('/:enrollmentId/final-exam', requireAuth, wrap(async (req, res) => submitQuiz(req, res, { isFinal: true })));

/** Attempt history, for the learner's own record. */
router.get(
  '/:enrollmentId/attempts',
  requireAuth,
  wrap(async (req, res) => {
    const enrollment = loadEnrollment(req);
    const attempts = db
      .prepare(
        `SELECT a.id, a.section_id, a.attempt_no, a.score, a.passed, a.created_at, s.title AS section_title
           FROM quiz_attempts a
      LEFT JOIN sections s ON s.id = a.section_id
          WHERE a.enrollment_id = ?
       ORDER BY a.id DESC`
      )
      .all(enrollment.id);
    res.json({ attempts });
  })
);

module.exports = router;
