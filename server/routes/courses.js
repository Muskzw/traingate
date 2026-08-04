'use strict';

/** Course authoring: upload, generation status, review/edit, publish. */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const db = require('../db');
const ai = require('../ai');
const jobs = require('../jobs');
const { requireAuth, requireRole, canManageCourse } = require('../auth');
const { wrap, bad, forbidden, notFound, clampInt } = require('../util');
const { SUPPORTED } = require('../extract');

const router = express.Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(SUPPORTED.includes(ext) ? null : new Error(`Unsupported file type. Upload one of: ${SUPPORTED.join(', ')}`), true);
  },
});

function loadCourse(req, { forWrite = true } = {}) {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(req.params.id));
  if (!course) throw notFound('Course not found.');
  if (forWrite && !canManageCourse(req.user, course)) throw forbidden('You cannot edit this course.');
  return course;
}

const parseQuestion = (q) => ({
  ...q,
  options: JSON.parse(q.options),
  correct: JSON.parse(q.correct),
});

/* ---------------------------- listing ---------------------------- */

router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    // Authors see their org's catalogue including drafts; learners see published only.
    const isAuthor = ['platform_admin', 'org_admin', 'instructor'].includes(req.user.role);
    const rows = db
      .prepare(
        `SELECT c.*, u.name AS owner_name,
                (SELECT COUNT(*) FROM sections s WHERE s.course_id = c.id) AS section_count,
                (SELECT COUNT(*) FROM questions q WHERE q.course_id = c.id) AS question_count,
                (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS enrolled_count
           FROM courses c
      LEFT JOIN users u ON u.id = c.owner_id
          WHERE (c.org_id IS ? OR c.org_id IS NULL) ${isAuthor ? '' : "AND c.status = 'published'"}
       ORDER BY c.updated_at DESC`
      )
      .all(req.user.org_id ?? null);
    res.json({ courses: rows });
  })
);

/* ---------------------------- upload ---------------------------- */

router.post(
  '/',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw bad('Attach a file to upload.');

    const title = String(req.body.title || '').trim() || 'Untitled course';
    const requireFinal = req.body.require_final_exam === 'true' || req.body.require_final_exam === '1';

    const info = db
      .prepare(
        `INSERT INTO courses
           (org_id, owner_id, title, source_filename, status, pass_threshold, max_attempts,
            retry_cooldown_sec, require_final_exam, final_pass_threshold, final_exam_questions,
            questions_per_section)
         VALUES (?, ?, ?, ?, 'generating', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.org_id ?? null,
        req.user.id,
        title,
        req.file.originalname,
        clampInt(req.body.pass_threshold, 0, 100, 80),
        clampInt(req.body.max_attempts, 0, 20, 0),
        clampInt(req.body.retry_cooldown_sec, 0, 86400, 0),
        requireFinal ? 1 : 0,
        clampInt(req.body.final_pass_threshold, 0, 100, 80),
        clampInt(req.body.final_exam_questions, 3, 60, 15),
        clampInt(req.body.questions_per_section, 1, 12, 4)
      );

    const courseId = Number(info.lastInsertRowid);

    // Keep the source file so an author can re-generate later.
    const stored = path.join(UPLOAD_DIR, `course-${courseId}${path.extname(req.file.originalname)}`);
    fs.writeFileSync(stored, req.file.buffer);

    const jobId = jobs.createJob(courseId);
    // Fire and forget — the browser polls /courses/:id/job for progress.
    jobs.runGeneration({
      jobId,
      courseId,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      hints: {
        title: title === 'Untitled course' ? '' : title,
        audience: String(req.body.audience || '').trim(),
        target_sections: clampInt(req.body.target_sections, 0, 60, 0) || null,
      },
    });

    res.status(202).json({ course_id: courseId, job_id: jobId });
  })
);

/** Re-run the pipeline against the stored source file. */
router.post(
  '/:id/regenerate',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    if (course.status === 'generating') throw bad('This course is already generating.');

    const stored = fs
      .readdirSync(UPLOAD_DIR)
      .find((f) => f.startsWith(`course-${course.id}.`));
    if (!stored) throw bad('The original upload is no longer available. Create a new course instead.');

    const buffer = fs.readFileSync(path.join(UPLOAD_DIR, stored));
    const jobId = jobs.createJob(course.id);
    jobs.runGeneration({
      jobId,
      courseId: course.id,
      buffer,
      filename: course.source_filename || stored,
      hints: { title: course.title },
    });
    res.status(202).json({ job_id: jobId });
  })
);

router.get(
  '/:id/job',
  requireAuth,
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const job = db
      .prepare('SELECT * FROM jobs WHERE course_id = ? ORDER BY id DESC LIMIT 1')
      .get(course.id);
    res.json({ job: job || null, course_status: course.status });
  })
);

/* ------------------------- read / edit -------------------------- */

router.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(req.params.id));
    if (!course) throw notFound('Course not found.');

    const manageable = canManageCourse(req.user, course);
    if (!manageable && course.status !== 'published') throw forbidden('This course is not published yet.');
    if (!manageable && course.org_id != null && course.org_id !== req.user.org_id) {
      throw forbidden('This course belongs to another company.');
    }

    const sections = db
      .prepare('SELECT * FROM sections WHERE course_id = ? ORDER BY position')
      .all(course.id);
    const questions = db
      .prepare('SELECT * FROM questions WHERE course_id = ? ORDER BY section_id, position')
      .all(course.id)
      .map(parseQuestion);

    // Answers are only ever exposed to someone who can edit the course.
    const shaped = manageable
      ? questions
      : questions.map(({ correct, explanation, ...rest }) => rest);

    res.json({
      course,
      manageable,
      sections: sections.map((s) => ({
        ...s,
        questions: shaped.filter((q) => q.section_id === s.id),
      })),
      final_exam: shaped.filter((q) => q.section_id === null),
    });
  })
);

router.patch(
  '/:id',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const b = req.body;
    const updates = {};

    if (typeof b.title === 'string' && b.title.trim()) updates.title = b.title.trim();
    if (typeof b.description === 'string') updates.description = b.description.trim();
    if (b.pass_threshold !== undefined) updates.pass_threshold = clampInt(b.pass_threshold, 0, 100, 80);
    if (b.max_attempts !== undefined) updates.max_attempts = clampInt(b.max_attempts, 0, 20, 0);
    if (b.retry_cooldown_sec !== undefined)
      updates.retry_cooldown_sec = clampInt(b.retry_cooldown_sec, 0, 86400, 0);
    if (b.final_pass_threshold !== undefined)
      updates.final_pass_threshold = clampInt(b.final_pass_threshold, 0, 100, 80);
    if (b.require_final_exam !== undefined) updates.require_final_exam = b.require_final_exam ? 1 : 0;
    if (b.certificate_enabled !== undefined) updates.certificate_enabled = b.certificate_enabled ? 1 : 0;
    if (b.open_enrollment !== undefined) updates.open_enrollment = b.open_enrollment ? 1 : 0;
    if (b.shuffle_questions !== undefined) updates.shuffle_questions = b.shuffle_questions ? 1 : 0;

    if (updates.require_final_exam === 1) {
      const existing = db
        .prepare('SELECT COUNT(*) AS n FROM questions WHERE course_id = ? AND section_id IS NULL')
        .get(course.id).n;
      if (existing === 0) {
        throw bad(
          'There is no final exam yet. Use "Generate final exam" first, then turn this on.'
        );
      }
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) throw bad('Nothing to update.');
    db.prepare(
      `UPDATE courses SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).run(...keys.map((k) => updates[k]), course.id);

    res.json({ course: db.prepare('SELECT * FROM courses WHERE id = ?').get(course.id) });
  })
);

router.post(
  '/:id/publish',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const sections = db.prepare('SELECT id FROM sections WHERE course_id = ?').all(course.id);
    if (sections.length === 0) throw bad('Add at least one section before publishing.');

    const missing = sections.filter(
      (s) =>
        db.prepare('SELECT COUNT(*) AS n FROM questions WHERE section_id = ?').get(s.id).n === 0
    );
    if (missing.length > 0) {
      throw bad(`${missing.length} section(s) have no quiz questions. Every section needs a quiz to act as a gate.`);
    }
    if (course.require_final_exam) {
      const n = db
        .prepare('SELECT COUNT(*) AS n FROM questions WHERE course_id = ? AND section_id IS NULL')
        .get(course.id).n;
      if (n === 0) throw bad('The final exam is switched on but has no questions.');
    }

    db.prepare(`UPDATE courses SET status = 'published', updated_at = datetime('now') WHERE id = ?`).run(
      course.id
    );
    res.json({ ok: true });
  })
);

router.post(
  '/:id/unpublish',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    db.prepare(`UPDATE courses SET status = 'ready', updated_at = datetime('now') WHERE id = ?`).run(
      course.id
    );
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const completed = db
      .prepare(`SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ? AND status = 'completed'`)
      .get(course.id).n;
    if (completed > 0 && req.query.force !== 'true') {
      throw bad(
        `${completed} people have completed this course. Deleting it destroys their completion records — re-send with force=true if that is intended.`
      );
    }
    db.prepare('DELETE FROM courses WHERE id = ?').run(course.id);
    res.json({ ok: true });
  })
);

/* --------------------------- sections --------------------------- */

router.patch(
  '/:id/sections/:sectionId',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const section = db
      .prepare('SELECT * FROM sections WHERE id = ? AND course_id = ?')
      .get(Number(req.params.sectionId), course.id);
    if (!section) throw notFound('Section not found.');

    const b = req.body;
    const updates = {};
    if (typeof b.title === 'string' && b.title.trim()) updates.title = b.title.trim();
    if (typeof b.summary === 'string') updates.summary = b.summary.trim();
    if (typeof b.content === 'string') updates.content = b.content;
    if (b.video_url !== undefined) updates.video_url = String(b.video_url || '').trim() || null;
    if (b.min_seconds !== undefined) updates.min_seconds = clampInt(b.min_seconds, 0, 7200, 60);

    const keys = Object.keys(updates);
    if (keys.length === 0) throw bad('Nothing to update.');
    db.prepare(`UPDATE sections SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => updates[k]),
      section.id
    );
    db.prepare(`UPDATE courses SET updated_at = datetime('now') WHERE id = ?`).run(course.id);
    res.json({ section: db.prepare('SELECT * FROM sections WHERE id = ?').get(section.id) });
  })
);

router.delete(
  '/:id/sections/:sectionId',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    db.prepare('DELETE FROM sections WHERE id = ? AND course_id = ?').run(
      Number(req.params.sectionId),
      course.id
    );
    // Keep positions contiguous so the learner's progress bar stays sane.
    const rest = db.prepare('SELECT id FROM sections WHERE course_id = ? ORDER BY position').all(course.id);
    const setPos = db.prepare('UPDATE sections SET position = ? WHERE id = ?');
    db.transaction(() => rest.forEach((s, i) => setPos.run(i + 1, s.id)))();
    res.json({ ok: true });
  })
);

/* --------------------------- questions -------------------------- */

function validateQuestionBody(b) {
  const prompt = String(b.prompt || '').trim();
  const options = Array.isArray(b.options) ? b.options.map((o) => String(o).trim()).filter(Boolean) : [];
  const correct = [...new Set((b.correct || []).map(Number))].sort((a, z) => a - z);

  if (!prompt) throw bad('The question needs a prompt.');
  if (options.length < 2) throw bad('Give at least two answer options.');
  if (correct.length === 0) throw bad('Mark at least one option as correct.');
  if (correct.some((i) => !Number.isInteger(i) || i < 0 || i >= options.length)) {
    throw bad('A correct-answer index points at an option that does not exist.');
  }
  if (correct.length === options.length) throw bad('Not every option can be correct.');

  const type =
    options.length === 2 && options[0] === 'True' && options[1] === 'False'
      ? 'true_false'
      : correct.length > 1
        ? 'multiple_choice'
        : 'single_choice';

  return { prompt, options, correct, type, explanation: String(b.explanation || '').trim() };
}

router.post(
  '/:id/questions',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const sectionId = req.body.section_id ? Number(req.body.section_id) : null;
    if (sectionId) {
      const ok = db.prepare('SELECT 1 FROM sections WHERE id = ? AND course_id = ?').get(sectionId, course.id);
      if (!ok) throw notFound('Section not found.');
    }
    const q = validateQuestionBody(req.body);
    const next =
      db
        .prepare(
          `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM questions
            WHERE course_id = ? AND section_id IS ?`
        )
        .get(course.id, sectionId).p;

    const info = db
      .prepare(
        `INSERT INTO questions (course_id, section_id, position, type, prompt, options, correct, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(course.id, sectionId, next, q.type, q.prompt, JSON.stringify(q.options), JSON.stringify(q.correct), q.explanation);

    res.status(201).json({
      question: parseQuestion(
        db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(info.lastInsertRowid))
      ),
    });
  })
);

router.patch(
  '/:id/questions/:questionId',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const existing = db
      .prepare('SELECT * FROM questions WHERE id = ? AND course_id = ?')
      .get(Number(req.params.questionId), course.id);
    if (!existing) throw notFound('Question not found.');

    const q = validateQuestionBody({
      prompt: req.body.prompt ?? existing.prompt,
      options: req.body.options ?? JSON.parse(existing.options),
      correct: req.body.correct ?? JSON.parse(existing.correct),
      explanation: req.body.explanation ?? existing.explanation,
    });

    db.prepare(
      'UPDATE questions SET type = ?, prompt = ?, options = ?, correct = ?, explanation = ? WHERE id = ?'
    ).run(q.type, q.prompt, JSON.stringify(q.options), JSON.stringify(q.correct), q.explanation, existing.id);

    res.json({
      question: parseQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(existing.id)),
    });
  })
);

router.delete(
  '/:id/questions/:questionId',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    db.prepare('DELETE FROM questions WHERE id = ? AND course_id = ?').run(
      Number(req.params.questionId),
      course.id
    );
    res.json({ ok: true });
  })
);

/** Regenerate one section's quiz, or the final exam (section_id omitted). */
router.post(
  '/:id/generate-questions',
  requireAuth,
  requireRole('org_admin', 'instructor'),
  wrap(async (req, res) => {
    const course = loadCourse(req);
    const sectionId = req.body.section_id ? Number(req.body.section_id) : null;
    const count = clampInt(req.body.count, 1, 60, sectionId ? course.questions_per_section : course.final_exam_questions);

    let raw;
    if (sectionId) {
      const section = db
        .prepare('SELECT * FROM sections WHERE id = ? AND course_id = ?')
        .get(sectionId, course.id);
      if (!section) throw notFound('Section not found.');
      raw = await ai.generateSectionQuiz({ courseTitle: course.title, section, count });
    } else {
      const sections = db
        .prepare('SELECT * FROM sections WHERE course_id = ? ORDER BY position')
        .all(course.id);
      if (sections.length === 0) throw bad('Generate sections first.');
      raw = await ai.generateFinalExam({ courseTitle: course.title, sections, count });
    }

    const questions = ai.sanitizeQuestions(raw);
    if (questions.length === 0) throw bad('The model did not return any usable questions. Try again.');

    db.transaction(() => {
      db.prepare('DELETE FROM questions WHERE course_id = ? AND section_id IS ?').run(course.id, sectionId);
      const insert = db.prepare(
        `INSERT INTO questions (course_id, section_id, position, type, prompt, options, correct, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      questions.forEach((q, i) =>
        insert.run(course.id, sectionId, i + 1, q.type, q.prompt, JSON.stringify(q.options), JSON.stringify(q.correct), q.explanation)
      );
    })();

    res.json({
      questions: db
        .prepare('SELECT * FROM questions WHERE course_id = ? AND section_id IS ? ORDER BY position')
        .all(course.id, sectionId)
        .map(parseQuestion),
    });
  })
);

module.exports = router;
