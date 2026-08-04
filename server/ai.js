'use strict';

/**
 * The AI pipeline. Three calls to Claude:
 *   1. sectionDocument()   — split the deck into logical, teachable sections
 *   2. generateSectionQuiz() — comprehension questions per section
 *   3. generateFinalExam()   — a cumulative exam across the whole course
 *
 * Every call uses structured outputs so the result is schema-valid JSON rather
 * than prose we have to salvage.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'high';

let _client;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to your .env file — the course generator cannot run without it.'
    );
  }
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Runs one structured-output request. Streaming is used throughout because
 * these are long generations and non-streaming requests risk HTTP timeouts.
 */
async function generate({ system, prompt, schema, maxTokens = 32000 }) {
  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(
      'The model declined to process this document. Check that the material is appropriate training content.'
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      'The generation hit the output limit before finishing. Try a smaller document, or fewer questions per section.'
    );
  }

  const text = message.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('The model returned no content.');

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The model returned malformed JSON.');
  }
}

/* ------------------------------------------------------------------ *
 * 1. Sectioning
 * ------------------------------------------------------------------ */

const sectionSchema = {
  type: 'object',
  properties: {
    course_title: { type: 'string' },
    course_description: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          content_markdown: { type: 'string' },
          key_points: { type: 'array', items: { type: 'string' } },
          source_first: { type: 'integer' },
          source_last: { type: 'integer' },
          estimated_minutes: { type: 'integer' },
        },
        required: [
          'title',
          'summary',
          'content_markdown',
          'key_points',
          'source_first',
          'source_last',
          'estimated_minutes',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['course_title', 'course_description', 'sections'],
  additionalProperties: false,
};

const SECTION_SYSTEM = `You are a corporate instructional designer. You turn a presenter's raw training material into a structured self-paced course.

Your sectioning must be pedagogical, not mechanical. Group source units by topic and learning objective — a section is "one thing a learner should be able to do or explain afterwards", not "every four slides". A section that covers a single idea in three slides is correct; so is one that spans twelve slides of a worked example.

For each section write content_markdown: the actual teaching text the learner reads. Expand the source material into prose that stands on its own — a slide that says only "Three risks" becomes a paragraph naming and explaining the three risks using the presenter notes and surrounding context. Never invent facts, statistics, policies, or requirements that are not supported by the source. Where the source is thin, teach what is there rather than padding.

Use headings, short paragraphs, and lists. Do not include a top-level H1 (the section title is rendered separately). Do not reference slide numbers in the learner-facing text.`;

async function sectionDocument({ transcript, unitCount, unitKind, hints = {} }) {
  const wanted = hints.target_sections
    ? `Aim for roughly ${hints.target_sections} sections.`
    : `Choose the number of sections the material actually calls for — typically one per 4-8 source units, but let the topics decide.`;

  const prompt = `Below is training material extracted from a ${unitKind.toUpperCase()} file containing ${unitCount} units (slides/pages/blocks), in order.

${hints.title ? `The presenter titled this material: "${hints.title}".\n` : ''}${hints.audience ? `Intended audience: ${hints.audience}.\n` : ''}
${wanted}

For each section set source_first and source_last to the unit numbers it covers (1-based, inclusive, non-overlapping, covering the material in order). Set estimated_minutes to a realistic reading time for content_markdown.

--- BEGIN MATERIAL ---
${transcript}
--- END MATERIAL ---`;

  return generate({ system: SECTION_SYSTEM, prompt, schema: sectionSchema, maxTokens: 64000 });
}

/* ------------------------------------------------------------------ *
 * 2 & 3. Question generation
 * ------------------------------------------------------------------ */

const questionSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['single_choice', 'multiple_choice', 'true_false'] },
          prompt: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_indices: { type: 'array', items: { type: 'integer' } },
          explanation: { type: 'string' },
          difficulty: { type: 'string', enum: ['recall', 'application', 'judgement'] },
        },
        required: ['type', 'prompt', 'options', 'correct_indices', 'explanation', 'difficulty'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

const QUIZ_SYSTEM = `You write comprehension checks for corporate training. The quiz's job is to confirm the learner actually worked through the material — not to trick them.

Rules that make a question good here:
- Answerable from the section text alone. Never require outside knowledge.
- Test understanding, not recall of exact wording. Prefer "what should you do when…" over "which word appeared on the slide".
- Distractors must be plausible to someone who skimmed and wrong to someone who read. No joke options, no giveaway lengths, no "all of the above".
- Vary which option index is correct.
- For true_false, options are exactly ["True", "False"].
- For multiple_choice, two or more options are correct, and the prompt says so explicitly ("Select all that apply").
- correct_indices are 0-based positions into options.
- explanation states why the right answer is right, in one or two sentences, grounded in the section.`;

async function generateSectionQuiz({ courseTitle, section, count }) {
  const prompt = `Course: "${courseTitle}"
Section: "${section.title}"

Write exactly ${count} questions covering this section. Mix difficulties: mostly "application", some "recall", and at most one "judgement". Include at most one true_false and at most one multiple_choice.

--- SECTION CONTENT ---
${section.content}
--- END SECTION CONTENT ---`;

  const out = await generate({
    system: QUIZ_SYSTEM,
    prompt,
    schema: questionSchema,
    maxTokens: 16000,
  });
  return out.questions;
}

async function generateFinalExam({ courseTitle, sections, count }) {
  const outline = sections
    .map((s, i) => `${i + 1}. ${s.title}\n${s.summary || s.content.slice(0, 400)}`)
    .join('\n\n');

  const prompt = `Course: "${courseTitle}"

Write exactly ${count} questions for the final exam. The exam is cumulative: distribute coverage across all sections proportionally to their weight, and favour questions that connect two or more sections over ones that repeat a single section's quiz. Lean on "application" and "judgement" difficulty.

--- COURSE OUTLINE ---
${outline}
--- END COURSE OUTLINE ---

--- FULL COURSE CONTENT ---
${sections.map((s) => `## ${s.title}\n${s.content}`).join('\n\n')}
--- END FULL COURSE CONTENT ---`;

  const out = await generate({
    system: QUIZ_SYSTEM,
    prompt,
    schema: questionSchema,
    maxTokens: 32000,
  });
  return out.questions;
}

/* ------------------------------------------------------------------ *
 * Validation — the model is reliable, but a bad question would silently
 * become an ungradeable gate, so every question is checked before storage.
 * ------------------------------------------------------------------ */

function sanitizeQuestions(raw) {
  const clean = [];
  for (const q of raw || []) {
    if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) continue;
    let options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
    let type = ['single_choice', 'multiple_choice', 'true_false'].includes(q.type)
      ? q.type
      : 'single_choice';

    if (type === 'true_false') options = ['True', 'False'];
    if (options.length < 2) continue;

    const correct = [...new Set((q.correct_indices || []).map(Number))]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
      .sort((a, b) => a - b);

    if (correct.length === 0) continue;                       // ungradeable
    if (correct.length === options.length) continue;          // everything correct
    if (type === 'multiple_choice' && correct.length < 2) type = 'single_choice';
    if (type !== 'multiple_choice' && correct.length > 1) type = 'multiple_choice';

    clean.push({
      type,
      prompt: q.prompt.trim(),
      options,
      correct,
      explanation: String(q.explanation || '').trim(),
    });
  }
  return clean;
}

module.exports = {
  sectionDocument,
  generateSectionQuiz,
  generateFinalExam,
  sanitizeQuestions,
  MODEL,
};
