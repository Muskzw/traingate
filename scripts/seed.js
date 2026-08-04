'use strict';

/**
 * Creates a demo company, two accounts, and a fully built published course —
 * without calling the AI. Useful for exploring the app before you have an API
 * key, and for testing the gate logic.
 *
 *   node scripts/seed.js
 */

require('dotenv').config();

const db = require('../server/db');
const { hashPassword } = require('../server/util');

const DEMO_PASSWORD = 'demo1234';

const COURSE = {
  title: 'AI in the Workforce',
  description:
    'A short introduction to using AI tools responsibly at work: what they are good at, where they fail, and the rules everyone is expected to follow.',
  sections: [
    {
      title: 'What these tools actually are',
      summary: 'How large language models work, in plain terms, and why that shapes everything else.',
      content: `## A prediction engine, not a database

A large language model does one thing: given the text so far, it predicts what text comes next. It repeats that prediction, word by word, until it has produced an answer.

That single fact explains most of what follows. The model is not looking anything up. It has no index of facts it consults before answering. It produces text that *looks like* a correct answer, and most of the time — because it was trained on an enormous amount of correct text — the answer is correct too.

### Why the distinction matters at work

- **Fluency is not accuracy.** A confident, well-written paragraph and a confident, well-written *wrong* paragraph look identical.
- **There is no "I checked" step** unless the tool has been given one (a search tool, a database connection, a document you supplied).
- **The model does not know what it does not know.** It cannot reliably tell you when it is guessing.

None of this makes the tools unreliable in practice. It means they need to be used the way you would use a fast, well-read colleague who never says "I'm not sure" — you take the draft, and you check the parts that matter.`,
      questions: [
        {
          prompt: 'A colleague says the AI assistant "looked up" your company holiday policy and got it wrong. What is the most accurate explanation?',
          options: [
            'It predicted plausible policy text rather than retrieving your actual policy',
            'It retrieved the policy but the file was out of date',
            'It searched the internet and found another company\'s policy',
            'The model was temporarily offline',
          ],
          correct: [0],
          explanation:
            'Unless it has been given a tool or your actual document, the model generates text that resembles a policy. It is not retrieving anything.',
        },
        {
          prompt: 'Which of these are direct consequences of a model predicting text rather than retrieving facts? Select all that apply.',
          options: [
            'A wrong answer can be just as fluent and confident as a right one',
            'The model cannot reliably flag when it is uncertain',
            'The model is unable to produce correct answers',
            'Output that matters needs to be checked by a person',
          ],
          correct: [0, 1, 3],
          explanation:
            'Prediction explains the confidence problem and the need for review. It does not make the tool inaccurate — most answers are correct, which is exactly why unchecked errors slip through.',
        },
        {
          prompt: 'True or False: because the model writes fluently, fluency is a reasonable signal that an answer is correct.',
          options: ['True', 'False'],
          correct: [1],
          explanation: 'Fluency is a property of how the text was generated, not of whether it is true.',
        },
      ],
    },
    {
      title: 'Where these tools help, and where they hurt',
      summary: 'Matching the tool to the task — and recognising the tasks where it should not be used at all.',
      content: `## Good fits

The tools are strongest where **the cost of a mistake is low and a human sees the output before it matters**:

- First drafts — emails, summaries, job descriptions, meeting notes
- Rewording and reformatting text you already have
- Explaining something unfamiliar so you know what to ask next
- Getting unstuck: naming options, listing considerations, breaking a task down

## Poor fits

They are weakest where **an error is expensive and invisible**:

- Anything presented as fact without a source — figures, dates, citations, legal or medical specifics
- Decisions about a named individual: hiring, discipline, performance, credit
- Work involving personal data or confidential material entered into a tool that is not approved
- Final output nobody will read before it goes out

### The rule of thumb

Ask one question before you use it: **if this output is wrong and nobody notices, what happens?**

If the answer is "an awkward email", go ahead. If the answer is "we make a decision about someone's job on false information", the tool is the wrong instrument — no matter how good the draft looks.`,
      questions: [
        {
          prompt: 'Which task is the best fit for an AI assistant?',
          options: [
            'Drafting a first version of a team update that you will edit',
            'Deciding which of two candidates to hire',
            'Producing the final compliance figures for a regulatory filing',
            'Determining whether a specific employee should be disciplined',
          ],
          correct: [0],
          explanation:
            'A draft you will edit is low-cost and human-reviewed. The other three are consequential decisions about people or regulated facts.',
        },
        {
          prompt: 'What single question does the section offer as a rule of thumb before using the tool?',
          options: [
            'If this output is wrong and nobody notices, what happens?',
            'Is this task on the approved list?',
            'Would a colleague do this faster?',
            'Has this tool been trained on our industry?',
          ],
          correct: [0],
          explanation:
            'It reframes the decision around the cost of an unnoticed error, which is the risk that actually matters.',
        },
        {
          prompt: 'You need a summary of a long report for your own reading, plus the exact revenue figure to put in a board pack. What is the appropriate use?',
          options: [
            'Use it for the summary; take the revenue figure from the source document',
            'Use it for both — it read the same report',
            'Use it for neither, since the report is confidential',
            'Use it for the figure only, since numbers are objective',
          ],
          correct: [0],
          explanation:
            'Summarising for your own orientation is low-stakes. A figure going into a board pack is a fact that must come from the source.',
        },
      ],
    },
    {
      title: 'The rules you are expected to follow',
      summary: 'Confidentiality, disclosure, and accountability — the three obligations that apply to everyone.',
      content: `## 1. Confidentiality

Do not paste into an unapproved tool: customer records, personal data about colleagues, unreleased financials, credentials, or anything covered by an NDA.

The test is simple — **would you post it to a public forum?** If not, it does not go into a tool the company has not approved.

## 2. Disclosure

Say when AI produced substantive content. You do not need to annotate a spell-check or a reworded sentence. You do need to say so when:

- The analysis or recommendation itself was AI-generated
- Someone might reasonably assume a person researched it
- The output goes to a customer, regulator, or the board

## 3. Accountability

**You own what you send.** Approving AI output makes it your work. "The AI wrote it" is not a defence for an error, and it will not be treated as one.

That means the person who presses send is responsible for checking:

- Facts and figures, against a real source
- Names, dates, and quotations
- That the tone and commitments are ones the company can stand behind

### If something goes wrong

Report it the same way you would any other error — promptly, to your manager. Errors caught early are inconvenient; errors found later by a customer or regulator are expensive.`,
      questions: [
        {
          prompt: 'What test does the section give for whether information can go into an unapproved AI tool?',
          options: [
            'Would you post it to a public forum?',
            'Is it more than a year old?',
            'Has it been shared outside your team?',
            'Is it marked confidential in the file name?',
          ],
          correct: [0],
          explanation:
            'The public-forum test is deliberately blunt — it avoids arguments about how sensitive something technically is.',
        },
        {
          prompt: 'Which situations require you to disclose that AI produced the content? Select all that apply.',
          options: [
            'The recommendation itself was AI-generated',
            'The output is going to a regulator',
            'You used it to fix spelling in an internal message',
            'A reader would reasonably assume a person researched it',
          ],
          correct: [0, 1, 3],
          explanation:
            'Disclosure attaches to substantive content and to audiences who would assume human work. Mechanical edits do not need it.',
        },
        {
          prompt: 'An AI-drafted client email you approved contained a wrong delivery date. Who is accountable?',
          options: [
            'You — approving the output made it your work',
            'The vendor who supplied the AI tool',
            'Nobody, because the error was automated',
            'The IT team that approved the tool',
          ],
          correct: [0],
          explanation: 'Accountability sits with the person who sent it. "The AI wrote it" is explicitly not a defence.',
        },
        {
          prompt: 'True or False: if you discover an AI-related error after sending, you should wait until you have a full fix before telling your manager.',
          options: ['True', 'False'],
          correct: [1],
          explanation: 'Report promptly. Errors found later by a customer or regulator are far more costly than early ones.',
        },
      ],
    },
  ],
  final_exam: [
    {
      prompt: 'Which statement best captures why AI output needs human review even when it is usually correct?',
      options: [
        'Errors are indistinguishable from correct answers in tone and confidence',
        'The tools are wrong more often than they are right',
        'Review is a legal requirement in every jurisdiction',
        'The tools slow down without periodic correction',
      ],
      correct: [0],
      explanation: 'The reliability is real, which is exactly why the occasional confident error passes unnoticed.',
    },
    {
      prompt: 'A manager asks the assistant to rank their five reports for redundancy, pasting in performance notes. Which obligations does this breach? Select all that apply.',
      options: [
        'Confidentiality — personal data about colleagues',
        'Appropriate use — a consequential decision about named individuals',
        'Disclosure — the output would not be labelled',
        'None; ranking is an analytical task',
      ],
      correct: [0, 1, 2],
      explanation:
        'It puts colleagues\' personal data into a tool, uses it for a decision about named people, and would likely be presented as the manager\'s own analysis.',
    },
    {
      prompt: 'You use AI to summarise a public industry report for your own understanding, then write your recommendation yourself. Is disclosure required?',
      options: [
        'No — the substantive analysis and recommendation are yours',
        'Yes — any AI use must always be disclosed',
        'Yes — because a report was involved',
        'Only if your manager asks',
      ],
      correct: [0],
      explanation:
        'Disclosure attaches to AI-generated substantive content. Using it to orient yourself before doing your own analysis does not meet that bar.',
    },
    {
      prompt: 'True or False: pasting a customer list into a personal AI account is acceptable if you delete the chat afterwards.',
      options: ['True', 'False'],
      correct: [1],
      explanation: 'The disclosure happens at the moment of pasting. Deleting the conversation afterwards does not undo it.',
    },
    {
      prompt: 'Which of these is the clearest example of a task where an unnoticed error is expensive?',
      options: [
        'A citation in a document going to a regulator',
        'A subject line on an internal newsletter',
        'A first draft of your own meeting notes',
        'A reworded paragraph you will read before sending',
      ],
      correct: [0],
      explanation: 'A fabricated citation in a regulatory document is both consequential and unlikely to be caught internally.',
    },
  ],
};

function seed() {
  const existing = db.prepare('SELECT id FROM organizations WHERE name = ?').get('Northwind Logistics');
  if (existing) {
    console.log('Demo data already present. Delete data/traingate.db to start over.');
    return;
  }

  const run = db.transaction(() => {
    const orgId = Number(
      db
        .prepare('INSERT INTO organizations (name, seats, contact_email) VALUES (?, ?, ?)')
        .run('Northwind Logistics', 20, 'admin@demo.test').lastInsertRowid
    );

    const mkUser = (email, name, role) =>
      Number(
        db
          .prepare('INSERT INTO users (org_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)')
          .run(orgId, email, name, hashPassword(DEMO_PASSWORD), role).lastInsertRowid
      );

    const adminId = mkUser('admin@demo.test', 'Dana Okafor', 'org_admin');
    const learnerId = mkUser('learner@demo.test', 'Sam Rivera', 'learner');
    mkUser('learner2@demo.test', 'Priya Chandra', 'learner');

    const courseId = Number(
      db
        .prepare(
          `INSERT INTO courses
             (org_id, owner_id, title, description, source_filename, status, pass_threshold,
              max_attempts, retry_cooldown_sec, require_final_exam, final_pass_threshold,
              final_exam_questions, questions_per_section, certificate_enabled, open_enrollment)
           VALUES (?, ?, ?, ?, ?, 'published', 75, 0, 0, 1, 80, ?, 3, 1, 1)`
        )
        .run(
          orgId,
          adminId,
          COURSE.title,
          COURSE.description,
          'ai-in-the-workforce.pptx',
          COURSE.final_exam.length
        ).lastInsertRowid
    );

    const insertSection = db.prepare(
      `INSERT INTO sections (course_id, position, title, summary, content, min_seconds, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertQuestion = db.prepare(
      `INSERT INTO questions (course_id, section_id, position, type, prompt, options, correct, explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const qType = (q) =>
      q.options.length === 2 && q.options[0] === 'True'
        ? 'true_false'
        : q.correct.length > 1
          ? 'multiple_choice'
          : 'single_choice';

    COURSE.sections.forEach((s, i) => {
      const sectionId = Number(
        insertSection.run(
          courseId,
          i + 1,
          s.title,
          s.summary,
          s.content,
          // Short on purpose so the demo gate is quick to walk through.
          20,
          `Slides ${i * 4 + 1}–${i * 4 + 4}`
        ).lastInsertRowid
      );
      s.questions.forEach((q, qi) =>
        insertQuestion.run(
          courseId,
          sectionId,
          qi + 1,
          qType(q),
          q.prompt,
          JSON.stringify(q.options),
          JSON.stringify(q.correct),
          q.explanation
        )
      );
    });

    COURSE.final_exam.forEach((q, qi) =>
      insertQuestion.run(
        courseId,
        null,
        qi + 1,
        qType(q),
        q.prompt,
        JSON.stringify(q.options),
        JSON.stringify(q.correct),
        q.explanation
      )
    );

    db.prepare('INSERT INTO enrollments (course_id, user_id, assigned_by) VALUES (?, ?, ?)').run(
      courseId,
      learnerId,
      adminId
    );

    return { courseId };
  });

  const { courseId } = run();

  console.log(`
Demo data created.

  Company    Northwind Logistics (20 seats)
  Course     "${COURSE.title}" — ${COURSE.sections.length} sections, final exam, published (id ${courseId})

  Administrator   admin@demo.test    / ${DEMO_PASSWORD}
  Learner         learner@demo.test  / ${DEMO_PASSWORD}   (course already assigned)
  Learner         learner2@demo.test / ${DEMO_PASSWORD}

Start the server with \`npm start\` and sign in at http://localhost:${process.env.PORT || 3000}
`);
}

module.exports = seed;

// Also runnable directly: `node scripts/seed.js`
if (require.main === module) seed();
