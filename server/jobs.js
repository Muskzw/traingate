'use strict';

/**
 * In-process job runner for course generation. One job per course; progress is
 * written to the `jobs` table so the browser can poll it.
 *
 * This is deliberately simple (no external queue). If the process restarts
 * mid-generation the job is marked failed on next boot and can be re-run.
 */

const db = require('./db');
const ai = require('./ai');
const { extractUnits, unitsToTranscript } = require('./extract');

const running = new Set();

function updateJob(jobId, patch) {
  const fields = Object.keys(patch);
  const sql = `UPDATE jobs SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  db.prepare(sql).run(...fields.map((f) => patch[f]), jobId);
}

function createJob(courseId) {
  const info = db
    .prepare(`INSERT INTO jobs (course_id, status, stage, message) VALUES (?, 'queued', 'queued', 'Waiting to start')`)
    .run(courseId);
  return info.lastInsertRowid;
}

/** Marks jobs orphaned by a crash/restart so the UI doesn't spin forever. */
function reapStaleJobs() {
  const n = db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = 'Server restarted while this job was running.', updated_at = datetime('now')
        WHERE status IN ('queued','running')`
    )
    .run().changes;
  if (n > 0) {
    db.prepare(`UPDATE courses SET status = 'failed' WHERE status = 'generating'`).run();
  }
  return n;
}

const insertSection = db.prepare(
  `INSERT INTO sections (course_id, position, title, summary, content, min_seconds, source_ref)
   VALUES (@course_id, @position, @title, @summary, @content, @min_seconds, @source_ref)`
);

const insertQuestion = db.prepare(
  `INSERT INTO questions (course_id, section_id, position, type, prompt, options, correct, explanation)
   VALUES (@course_id, @section_id, @position, @type, @prompt, @options, @correct, @explanation)`
);

/**
 * Runs the full pipeline: extract -> section -> per-section quizzes -> final exam.
 * Resolves when done; errors are captured on the job row rather than thrown.
 */
async function runGeneration({ jobId, courseId, buffer, filename, hints }) {
  const key = `course:${courseId}`;
  if (running.has(key)) return;
  running.add(key);

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);

  try {
    db.prepare(`UPDATE courses SET status = 'generating' WHERE id = ?`).run(courseId);
    updateJob(jobId, { status: 'running', stage: 'extract', progress: 5, message: 'Reading the document' });

    const { kind, units } = await extractUnits(buffer, filename);
    const transcript = unitsToTranscript(units);

    updateJob(jobId, {
      stage: 'sectioning',
      progress: 15,
      message: `Splitting ${units.length} ${kind === 'pptx' ? 'slides' : 'units'} into sections`,
    });

    const plan = await ai.sectionDocument({
      transcript,
      unitCount: units.length,
      unitKind: kind,
      hints,
    });

    const planned = Array.isArray(plan.sections) ? plan.sections.filter((s) => s && s.title) : [];
    if (planned.length === 0) throw new Error('The model produced no sections for this document.');

    // Replace any previous generation for this course.
    db.prepare('DELETE FROM questions WHERE course_id = ?').run(courseId);
    db.prepare('DELETE FROM sections WHERE course_id = ?').run(courseId);

    const titleFromModel = String(plan.course_title || '').trim();
    db.prepare(
      `UPDATE courses SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      course.title && course.title !== 'Untitled course' ? course.title : titleFromModel || 'Untitled course',
      String(plan.course_description || '').trim(),
      courseId
    );

    const sectionIds = [];
    planned.forEach((s, i) => {
      const minutes = Number(s.estimated_minutes) || 3;
      const info = insertSection.run({
        course_id: courseId,
        position: i + 1,
        title: String(s.title).trim(),
        summary: String(s.summary || '').trim(),
        content: String(s.content_markdown || '').trim(),
        // Dwell gate: the learner must spend at least this long before the quiz
        // unlocks. Half the estimated reading time, floored at 30s.
        min_seconds: Math.max(30, Math.round(minutes * 30)),
        source_ref:
          s.source_first != null && s.source_last != null
            ? `${kind === 'pptx' ? 'Slides' : 'Units'} ${s.source_first}–${s.source_last}`
            : null,
      });
      sectionIds.push(Number(info.lastInsertRowid));
    });

    // Per-section quizzes.
    const perSection = course.questions_per_section || 4;
    for (let i = 0; i < sectionIds.length; i++) {
      const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionIds[i]);
      updateJob(jobId, {
        stage: 'quizzes',
        progress: 20 + Math.round((i / sectionIds.length) * 60),
        message: `Writing quiz ${i + 1} of ${sectionIds.length}: ${section.title}`,
      });

      const raw = await ai.generateSectionQuiz({
        courseTitle: titleFromModel || course.title,
        section,
        count: perSection,
      });
      const questions = ai.sanitizeQuestions(raw);
      if (questions.length === 0) {
        throw new Error(`No usable questions were produced for section "${section.title}".`);
      }
      questions.forEach((q, qi) =>
        insertQuestion.run({
          course_id: courseId,
          section_id: section.id,
          position: qi + 1,
          type: q.type,
          prompt: q.prompt,
          options: JSON.stringify(q.options),
          correct: JSON.stringify(q.correct),
          explanation: q.explanation,
        })
      );
    }

    // Final exam (optional per course settings).
    if (course.require_final_exam) {
      updateJob(jobId, { stage: 'final_exam', progress: 85, message: 'Writing the final exam' });
      const sections = db
        .prepare('SELECT * FROM sections WHERE course_id = ? ORDER BY position')
        .all(courseId);
      const raw = await ai.generateFinalExam({
        courseTitle: titleFromModel || course.title,
        sections,
        count: course.final_exam_questions || 15,
      });
      const questions = ai.sanitizeQuestions(raw);
      questions.forEach((q, qi) =>
        insertQuestion.run({
          course_id: courseId,
          section_id: null,
          position: qi + 1,
          type: q.type,
          prompt: q.prompt,
          options: JSON.stringify(q.options),
          correct: JSON.stringify(q.correct),
          explanation: q.explanation,
        })
      );
    }

    db.prepare(`UPDATE courses SET status = 'ready', updated_at = datetime('now') WHERE id = ?`).run(
      courseId
    );
    updateJob(jobId, {
      status: 'done',
      stage: 'done',
      progress: 100,
      message: `Generated ${sectionIds.length} sections. Review and publish.`,
    });
  } catch (err) {
    db.prepare(`UPDATE courses SET status = 'failed' WHERE id = ?`).run(courseId);
    updateJob(jobId, {
      status: 'failed',
      stage: 'failed',
      message: 'Generation failed',
      error: String(err.message || err),
    });
  } finally {
    running.delete(key);
  }
}

module.exports = { createJob, runGeneration, reapStaleJobs, updateJob };
