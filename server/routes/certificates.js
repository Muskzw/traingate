'use strict';

/**
 * Certificates are public by code so a hiring manager or auditor can verify one
 * without an account. The code is the only secret, and it reveals nothing
 * beyond what a printed certificate already shows.
 */

const express = require('express');
const db = require('../db');
const { wrap, notFound, escapeHtml } = require('../util');

const router = express.Router();

const findByCode = (code) =>
  db
    .prepare(
      `SELECT cert.*, c.title AS course_title_live, e.completed_at, e.final_score,
              (SELECT COUNT(*) FROM sections s WHERE s.course_id = c.id) AS section_count
         FROM certificates cert
         JOIN enrollments e ON e.id = cert.enrollment_id
         JOIN courses c ON c.id = e.course_id
        WHERE cert.code = ?`
    )
    .get(String(code || '').trim().toUpperCase());

/** JSON verification endpoint. */
router.get(
  '/api/certificates/:code',
  wrap(async (req, res) => {
    const cert = findByCode(req.params.code);
    if (!cert) return res.status(404).json({ valid: false, error: 'No certificate with that code.' });
    res.json({
      valid: true,
      certificate: {
        code: cert.code,
        learner_name: cert.learner_name,
        course_title: cert.course_title,
        org_name: cert.org_name,
        score: cert.score,
        issued_at: cert.issued_at,
        completed_at: cert.completed_at,
        sections: cert.section_count,
      },
    });
  })
);

/** Printable certificate page. This is the link that gets shared. */
router.get('/c/:code', (req, res) => {
  const cert = findByCode(req.params.code);
  const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

  if (!cert) {
    res.status(404).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Certificate not found</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1115;color:#e7e9ee}
.card{text-align:center;padding:48px;border:1px solid #262b36;border-radius:16px;background:#161a22}</style></head>
<body><div class="card"><h1>No such certificate</h1>
<p>The code <strong>${escapeHtml(req.params.code)}</strong> does not match any certificate we have issued.</p>
<p><a href="${publicUrl}" style="color:#7aa2f7">Back to TrainGate</a></p></div></body></html>`);
    return;
  }

  const issued = new Date((cert.issued_at || '').replace(' ', 'T') + 'Z');
  const issuedText = Number.isNaN(issued.getTime())
    ? cert.issued_at
    : issued.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Certificate — ${escapeHtml(cert.learner_name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; background:#eceff4; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         min-height:100vh; display:grid; place-items:center; padding:32px 16px; color:#1c2028; }
  .sheet { width:min(900px,100%); background:#fff; border-radius:4px; padding:64px clamp(24px,6vw,88px);
           box-shadow:0 24px 60px rgba(20,26,40,.16); border-top:8px solid #2f5fd0; text-align:center; }
  .eyebrow { letter-spacing:.28em; text-transform:uppercase; font-size:12px; color:#5b6478; margin:0 0 40px; }
  .awarded { font-size:14px; color:#5b6478; margin:0 0 8px; }
  .name { font-family:Georgia,"Times New Roman",serif; font-size:clamp(32px,6vw,52px); margin:0 0 28px;
          padding-bottom:20px; border-bottom:1px solid #dfe3ea; }
  .for { font-size:14px; color:#5b6478; margin:0 0 8px; }
  .course { font-size:clamp(20px,3.4vw,28px); font-weight:600; margin:0 0 36px; line-height:1.3; }
  .meta { display:flex; flex-wrap:wrap; gap:32px; justify-content:center; margin:36px 0 0;
          padding-top:28px; border-top:1px solid #dfe3ea; }
  .meta div { min-width:120px; }
  .meta dt { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:#77809a; margin-bottom:6px; }
  .meta dd { margin:0; font-size:15px; font-weight:600; }
  .verify { margin-top:36px; font-size:12px; color:#77809a; line-height:1.7; }
  .verify a { color:#2f5fd0; }
  .actions { margin-top:24px; display:flex; gap:12px; justify-content:center; }
  button, .btn { font:inherit; font-size:14px; padding:10px 20px; border-radius:8px; border:1px solid #c9cfdc;
                 background:#fff; cursor:pointer; text-decoration:none; color:#1c2028; }
  button.primary { background:#2f5fd0; border-color:#2f5fd0; color:#fff; }
  @media print { body { background:#fff; padding:0; } .sheet { box-shadow:none; } .actions { display:none; } }
</style>
</head>
<body>
  <main class="sheet">
    <p class="eyebrow">Certificate of Completion</p>
    <p class="awarded">This certifies that</p>
    <h1 class="name">${escapeHtml(cert.learner_name)}</h1>
    <p class="for">has successfully completed</p>
    <p class="course">${escapeHtml(cert.course_title)}</p>
    <dl class="meta">
      ${cert.org_name ? `<div><dt>Organization</dt><dd>${escapeHtml(cert.org_name)}</dd></div>` : ''}
      <div><dt>Issued</dt><dd>${escapeHtml(issuedText)}</dd></div>
      ${cert.score != null ? `<div><dt>Score</dt><dd>${Math.round(cert.score)}%</dd></div>` : ''}
      <div><dt>Modules</dt><dd>${cert.section_count}</dd></div>
      <div><dt>Certificate ID</dt><dd>${escapeHtml(cert.code)}</dd></div>
    </dl>
    <p class="verify">
      Verify this certificate at<br>
      <a href="${publicUrl}/c/${escapeHtml(cert.code)}">${publicUrl}/c/${escapeHtml(cert.code)}</a>
    </p>
    <div class="actions">
      <button class="primary" onclick="window.print()">Print / Save as PDF</button>
      <a class="btn" href="${publicUrl}">Back to TrainGate</a>
    </div>
  </main>
</body>
</html>`);
});

module.exports = router;
