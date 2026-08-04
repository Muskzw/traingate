/* TrainGate SPA — hash-routed, no build step, no framework. */
'use strict';

/* =============================================================== state */

const state = {
  token: localStorage.getItem('tg_token') || null,
  user: null,
  route: { name: '', params: {} },
  health: null,
};

const app = () => document.getElementById('app');

/** Server capabilities, fetched once per page load. Never throws. */
async function health() {
  if (!state.health) {
    try { state.health = await (await fetch('/api/health')).json(); } catch { return {}; }
  }
  return state.health;
}

/* ================================================================ util */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const attr = (s) => esc(s).replace(/\n/g, '&#10;');

function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, kind === 'bad' ? 6000 : 3600);
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body && !raw) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && state.token) {
    signOutLocal();
    throw new Error('Your session expired. Sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function timeAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

const clock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/** Minimal Markdown → HTML. Input is model-generated or author-edited text. */
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null;
  let para = [];

  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushPara(); flushList(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const level = Math.min(4, h[1].length + 1); // demote: section title owns h1
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }

    if (/^>\s?/.test(line)) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

/** Turns a YouTube/Vimeo/direct URL into an embeddable player. */
function videoEmbed(url) {
  if (!url) return '';
  const u = String(url).trim();
  let m;
  if ((m = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,})/))) {
    return `<div class="videoframe"><iframe src="https://www.youtube.com/embed/${esc(m[1])}" allowfullscreen title="Course video"></iframe></div>`;
  }
  if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/))) {
    return `<div class="videoframe"><iframe src="https://player.vimeo.com/video/${esc(m[1])}" allowfullscreen title="Course video"></iframe></div>`;
  }
  if (/\.(mp4|webm|ogg|m4v)(\?.*)?$/i.test(u)) {
    return `<div class="videoframe"><video src="${attr(u)}" controls preload="metadata"></video></div>`;
  }
  return `<p><a href="${attr(u)}" target="_blank" rel="noopener">Open the course video ↗</a></p>`;
}

const isAuthor = () => ['platform_admin', 'org_admin', 'instructor'].includes(state.user?.role);
const isAdmin = () => ['platform_admin', 'org_admin'].includes(state.user?.role);

/* ============================================================== chrome */

function topbar() {
  const links = [{ href: '#/', label: 'My training' }];
  if (isAuthor()) links.push({ href: '#/courses', label: 'Courses' });
  if (isAuthor()) links.push({ href: '#/team', label: 'Team' });
  links.push({ href: '#/verify', label: 'Verify' });

  const here = location.hash || '#/';
  return `
  <header class="topbar">
    <a class="brand" href="#/"><span class="brand-mark">TG</span> TrainGate</a>
    <nav class="nav">
      ${links
        .map(
          (l) =>
            `<a href="${l.href}" class="${here === l.href || (l.href !== '#/' && here.startsWith(l.href)) ? 'active' : ''}">${esc(l.label)}</a>`
        )
        .join('')}
    </nav>
    <div class="topbar-right">
      <div class="whoami">
        <strong>${esc(state.user.name)}</strong>
        ${esc(state.user.org_name || 'No company')} · ${esc(roleLabel(state.user.role))}
      </div>
      <button class="small ghost" id="btn-account">Account</button>
      <button class="small" id="btn-signout">Sign out</button>
    </div>
  </header>`;
}

const roleLabel = (r) =>
  ({ platform_admin: 'Platform admin', org_admin: 'Administrator', instructor: 'Instructor', learner: 'Learner' }[r] || r);

function render(inner, { chrome = true } = {}) {
  app().className = '';
  app().innerHTML = (chrome && state.user ? topbar() : '') + inner;

  document.getElementById('btn-signout')?.addEventListener('click', signOut);
  document.getElementById('btn-account')?.addEventListener('click', accountModal);
}

function modal(html) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  return back;
}

/* ============================================================= landing */

/** Topbar for visitors who are not signed in. */
function publicTopbar() {
  return `
  <header class="topbar">
    <a class="brand" href="#/"><span class="brand-mark">TG</span> TrainGate</a>
    <nav class="nav">
      <a href="#/verify" class="${location.hash === '#/verify' ? 'active' : ''}">Verify a certificate</a>
    </nav>
    <div class="topbar-right">
      <a class="button small" href="#/signin">Sign in</a>
      <a class="button small primary" href="#/signup">Get started</a>
    </div>
  </header>`;
}

const HOW = [
  ['Upload the deck you already have', 'A PowerPoint or PDF you use for onboarding, compliance, safety, policy. No rewriting, no authoring tool.'],
  ['Claude turns it into a course', 'It splits the material into teachable sections, writes comprehension questions for each, and drafts a final exam.'],
  ['Progress is gated, not assumed', 'A learner cannot skip ahead. Each section unlocks only when its quiz is passed, so completion means something.'],
  ['Everyone gets a verifiable certificate', 'Issued with an ID anyone — an auditor, a client, a regulator — can check on a public page.'],
];

const WHY = [
  ['📄', 'Your material, not generic content', 'Courses are built from the deck you upload, so the wording, policies and examples are yours.'],
  ['🔒', 'Real completion evidence', 'Time on section is tracked and quizzes must be passed. "I watched it" stops being the standard.'],
  ['👥', 'Built for teams', 'Add employees, assign training, and watch a live progress table across the whole company.'],
  ['🎓', 'Certificates that verify', 'Every certificate carries a public ID. Paste it into the verify page and the record comes back.'],
];

async function viewLanding() {
  let health = {};
  try { health = await (await fetch('/api/health')).json(); } catch { /* offline: hide demo box */ }

  render(
    `
  ${publicTopbar()}
  <main class="landing">
    <section class="lp-hero">
      <span class="badge accent">Powered by Claude</span>
      <h1>Turn the training deck you already have into a course people can't fake their way through.</h1>
      <p class="lp-sub">
        Upload a presentation. TrainGate splits it into sections, writes a quiz for each one, blocks
        progress until each quiz is passed, and issues a certificate anyone can verify.
      </p>
      <div class="lp-cta">
        <a class="button primary" href="#/signup">Create a company account</a>
        ${health.demo ? `<button id="lp-demo">Take a tour with demo data</button>` : `<a class="button" href="#/signin">Sign in</a>`}
      </div>
      ${health.demo ? `<p class="faint" style="margin-top:14px">Signs you in as a demo learner with a course already assigned. Nothing to set up.</p>` : ''}
    </section>

    <section class="lp-section">
      <h2 class="lp-h2">How it works</h2>
      <ol class="lp-steps">
        ${HOW.map(
          ([t, d], i) => `
          <li class="lp-step">
            <span class="lp-step-n">${i + 1}</span>
            <div><h3>${esc(t)}</h3><p class="muted">${esc(d)}</p></div>
          </li>`
        ).join('')}
      </ol>
    </section>

    <section class="lp-section">
      <h2 class="lp-h2">Why teams use it</h2>
      <div class="grid grid-2">
        ${WHY.map(
          ([icon, t, d]) => `
          <div class="card lp-feature">
            <span class="lp-icon" aria-hidden="true">${icon}</span>
            <h3>${esc(t)}</h3>
            <p class="muted" style="margin:0">${esc(d)}</p>
          </div>`
        ).join('')}
      </div>
    </section>

    <section class="lp-final card">
      <h2>See it with your own material</h2>
      <p class="muted">Create a company account, upload one deck, and you will have a gated course in a few minutes.</p>
      <div class="lp-cta">
        <a class="button primary" href="#/signup">Get started</a>
        <a class="button" href="#/verify">Verify a certificate</a>
      </div>
    </section>

    <footer class="lp-foot">
      <span>TrainGate</span>
      <span class="faint">Course generation runs on the Anthropic API.</span>
    </footer>
  </main>`,
    { chrome: false }
  );

  document.getElementById('lp-demo')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Signing in…';
    try {
      const out = await api('/api/auth/login', {
        method: 'POST',
        body: { email: 'learner@demo.test', password: 'demo1234' },
      });
      state.token = out.token;
      state.user = out.user;
      localStorage.setItem('tg_token', out.token);
      location.hash = '#/';
      route();
    } catch (err) {
      toast(err.message, 'bad');
      e.target.disabled = false;
      e.target.textContent = 'Take a tour with demo data';
    }
  });
}

/* ================================================================ auth */

function signOutLocal() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('tg_token');
  location.hash = '#/';
  route();
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
  signOutLocal();
}

function renderAuth(mode = 'login') {
  render(
    `
  <div class="auth-wrap">
    <div class="auth-card stack">
      <div class="center">
        <a class="brand" href="#/" style="justify-content:center;font-size:19px;margin-bottom:6px">
          <span class="brand-mark">TG</span> TrainGate
        </a>
        <p class="muted" style="margin:0">Training your people actually complete — and you can prove it.</p>
      </div>

      <div class="card">
        <div class="auth-tabs">
          <button class="${mode === 'login' ? 'on' : ''}" data-mode="login">Sign in</button>
          <button class="${mode === 'register' ? 'on' : ''}" data-mode="register">Create a company</button>
        </div>

        <form id="auth-form" class="stack">
          ${
            mode === 'register'
              ? `<div class="field"><label for="a-org">Company name</label>
                   <input id="a-org" name="org_name" required placeholder="Acme Corporation"></div>
                 <div class="field"><label for="a-name">Your name</label>
                   <input id="a-name" name="name" required placeholder="Jane Mazambani"></div>`
              : ''
          }
          <div class="field"><label for="a-email">Work email</label>
            <input id="a-email" name="email" type="email" required autocomplete="email" placeholder="you@company.com"></div>
          <div class="field" style="margin-bottom:8px"><label for="a-pass">Password</label>
            <input id="a-pass" name="password" type="password" required minlength="8"
                   autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}"
                   placeholder="${mode === 'register' ? 'At least 8 characters' : ''}"></div>
          <div id="auth-error"></div>
          <button class="primary block" type="submit">
            ${mode === 'register' ? 'Create company account' : 'Sign in'}
          </button>
        </form>
      </div>

      ${
        mode === 'register'
          ? `<p class="faint center">You become the administrator. You can add employees and assign training right after.</p>`
          : `<p class="faint center">Employees: your administrator gives you a password. <a href="#/verify">Verify a certificate</a> instead.</p>`
      }
    </div>
  </div>`,
    { chrome: false }
  );

  // Route through the hash so the back button works between the two modes.
  document.querySelectorAll('.auth-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      location.hash = b.dataset.mode === 'register' ? '#/signup' : '#/signin';
    })
  );

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const errBox = document.getElementById('auth-error');
    errBox.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Working…';

    const form = Object.fromEntries(new FormData(e.target));
    try {
      const out = await api(`/api/auth/${mode}`, { method: 'POST', body: form });
      state.token = out.token;
      state.user = out.user;
      localStorage.setItem('tg_token', out.token);
      location.hash = '#/';
      route();
    } catch (err) {
      errBox.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = mode === 'register' ? 'Create company account' : 'Sign in';
    }
  });
}

function accountModal() {
  const back = modal(`
    <h2>Account</h2>
    <p class="muted">${esc(state.user.email)} · ${esc(roleLabel(state.user.role))}${state.user.org_name ? ` at ${esc(state.user.org_name)}` : ''}</p>
    <form id="pw-form" class="stack" style="margin-top:18px">
      <div class="field"><label for="pw-cur">Current password</label>
        <input id="pw-cur" name="current_password" type="password" required autocomplete="current-password"></div>
      <div class="field"><label for="pw-new">New password</label>
        <input id="pw-new" name="new_password" type="password" required minlength="8" autocomplete="new-password"></div>
      <div class="row row-end">
        <button type="button" id="pw-cancel">Close</button>
        <button class="primary" type="submit">Change password</button>
      </div>
    </form>`);

  back.querySelector('#pw-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await api('/api/auth/password', {
        method: 'POST',
        body: Object.fromEntries(new FormData(e.target)),
      });
      state.token = out.token;
      localStorage.setItem('tg_token', out.token);
      back.remove();
      toast('Password changed.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

/* =========================================================== dashboard */

async function viewDashboard() {
  const { enrollments, available } = await api('/api/learn');

  const active = enrollments.filter((e) => e.status !== 'completed');
  const done = enrollments.filter((e) => e.status === 'completed');

  const card = (e) => {
    const pct = e.total_sections ? Math.round((e.passed_sections / e.total_sections) * 100) : 0;
    const complete = e.status === 'completed';
    return `
      <div class="card stack">
        <div class="card-head">
          <div class="grow">
            <h3>${esc(e.title)}</h3>
            <p class="faint" style="margin:0">${plural(e.total_sections, 'section')}${e.require_final_exam ? ' · final exam' : ''}</p>
          </div>
          <span class="badge ${complete ? 'good' : e.status === 'in_progress' ? 'accent' : ''}">
            ${complete ? 'Complete' : e.status === 'in_progress' ? 'In progress' : 'Not started'}
          </span>
        </div>
        ${e.description ? `<p class="muted" style="margin:0;font-size:14px">${esc(e.description.slice(0, 180))}${e.description.length > 180 ? '…' : ''}</p>` : ''}
        <div>
          <div class="bar ${complete ? 'good' : ''}"><span style="width:${pct}%"></span></div>
          <p class="faint" style="margin:6px 0 0">${e.passed_sections} of ${e.total_sections} sections passed${complete && e.final_score != null ? ` · scored ${Math.round(e.final_score)}%` : ''}</p>
        </div>
        <div class="row">
          <a class="button ${complete ? '' : 'primary'}" href="#/learn/${e.id}">
            ${complete ? 'Review' : e.status === 'in_progress' ? 'Continue' : 'Start training'}
          </a>
          ${e.certificate_code ? `<a class="button" href="/c/${esc(e.certificate_code)}" target="_blank" rel="noopener">Certificate ↗</a>` : ''}
        </div>
      </div>`;
  };

  render(`
  <main class="page">
    <div class="page-head">
      <div class="grow">
        <h1>My training</h1>
        <p>${active.length ? `${plural(active.length, 'course')} waiting for you.` : 'Nothing outstanding. Nice.'}</p>
      </div>
      ${isAuthor() ? `<a class="button primary" href="#/courses">Create a course</a>` : ''}
    </div>

    ${
      enrollments.length === 0
        ? `<div class="empty">
             <p><strong>No training assigned yet.</strong></p>
             <p>${isAuthor() ? 'Upload a presentation to build your first course.' : 'Your administrator will assign training to you.'}</p>
             ${isAuthor() ? `<a class="button primary" href="#/courses">Upload a presentation</a>` : ''}
           </div>`
        : ''
    }

    ${active.length ? `<div class="grid grid-2">${active.map(card).join('')}</div>` : ''}

    ${
      available.length
        ? `<h2 style="margin-top:36px">Available to you</h2>
           <div class="grid grid-2">
             ${available
               .map(
                 (c) => `<div class="card stack">
                   <h3 style="margin:0">${esc(c.title)}</h3>
                   ${c.description ? `<p class="muted" style="margin:0;font-size:14px">${esc(c.description.slice(0, 160))}</p>` : ''}
                   <div><button class="primary" data-enroll="${c.id}">Enroll</button></div>
                 </div>`
               )
               .join('')}
           </div>`
        : ''
    }

    ${
      done.length
        ? `<h2 style="margin-top:36px">Completed</h2><div class="grid grid-2">${done.map(card).join('')}</div>`
        : ''
    }
  </main>`);

  document.querySelectorAll('[data-enroll]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const out = await api('/api/learn/enroll', {
          method: 'POST',
          body: { course_id: Number(b.dataset.enroll) },
        });
        location.hash = `#/learn/${out.enrollment_id}`;
      } catch (err) {
        toast(err.message, 'bad');
        b.disabled = false;
      }
    })
  );
}

/* ============================================================= courses */

async function viewCourses() {
  const [{ courses }, cfg] = await Promise.all([api('/api/courses'), health()]);
  const aiOff = cfg.ai_configured === false;

  const statusBadge = (s) =>
    ({
      published: '<span class="badge good">Published</span>',
      ready: '<span class="badge accent">Ready to review</span>',
      generating: '<span class="badge warn">Generating…</span>',
      failed: '<span class="badge bad">Failed</span>',
    }[s] || '<span class="badge">Draft</span>');

  render(`
  <main class="page page-wide">
    <div class="page-head">
      <div class="grow">
        <h1>Courses</h1>
        <p>Upload a deck and TrainGate writes the course: sections, quizzes, and the gate between them.</p>
      </div>
      <button class="primary" id="btn-new-course" ${aiOff ? 'disabled' : ''}>Upload presentation</button>
    </div>

    ${
      aiOff
        ? `<div class="notice warn" style="margin-bottom:20px">
             <strong>Course generation is switched off on this demo.</strong>
             Building a course from a deck calls the Anthropic API, which needs a funded API key.
             Everything else — the gated player, quizzes, team management and certificates —
             works on the example course below.
           </div>`
        : ''
    }

    ${
      courses.length === 0
        ? `<div class="empty">
             <p><strong>No courses yet.</strong></p>
             <p>Start with the PowerPoint you already present from.</p>
             <button class="primary" id="btn-new-course-2" ${aiOff ? 'disabled' : ''}>Upload presentation</button>
           </div>`
        : `<div class="card" style="padding:8px">
             <div class="table-wrap"><table>
               <thead><tr>
                 <th>Course</th><th>Status</th><th>Structure</th><th>Enrolled</th><th>Updated</th><th></th>
               </tr></thead>
               <tbody>
                 ${courses
                   .map(
                     (c) => `<tr>
                       <td>
                         <strong>${esc(c.title)}</strong>
                         ${c.source_filename ? `<div class="faint">${esc(c.source_filename)}</div>` : ''}
                       </td>
                       <td>${statusBadge(c.status)}</td>
                       <td class="muted">${c.section_count} sections · ${c.question_count} questions${c.require_final_exam ? ' · exam' : ''}</td>
                       <td class="muted">${c.enrolled_count}</td>
                       <td class="muted">${timeAgo(c.updated_at)}</td>
                       <td style="text-align:right"><a class="button small" href="#/courses/${c.id}">Open</a></td>
                     </tr>`
                   )
                   .join('')}
               </tbody>
             </table></div>
           </div>`
    }
  </main>`);

  document.getElementById('btn-new-course')?.addEventListener('click', uploadModal);
  document.getElementById('btn-new-course-2')?.addEventListener('click', uploadModal);
}

function uploadModal() {
  const back = modal(`
    <h2>New course from a presentation</h2>
    <p class="muted">PowerPoint (.pptx) works best — slide boundaries and presenter notes both feed the model. Word, PDF, Markdown and plain text also work.</p>

    <form id="up-form" class="stack" style="margin-top:18px">
      <div class="field">
        <label for="up-file">Source file</label>
        <input id="up-file" name="file" type="file" required accept=".pptx,.docx,.pdf,.txt,.md">
        <div class="field-hint">Up to 40 MB.</div>
      </div>

      <div class="field">
        <label for="up-title">Course title <span class="faint">(optional)</span></label>
        <input id="up-title" name="title" placeholder="Leave blank and the model will name it">
      </div>

      <div class="field">
        <label for="up-audience">Who is this for? <span class="faint">(optional)</span></label>
        <input id="up-audience" name="audience" placeholder="e.g. All staff, no technical background">
        <div class="field-hint">Helps the model pitch the writing and questions correctly.</div>
      </div>

      <div class="grid grid-2">
        <div class="field">
          <label for="up-qps">Questions per section</label>
          <input id="up-qps" name="questions_per_section" type="number" min="1" max="12" value="4">
        </div>
        <div class="field">
          <label for="up-pass">Pass mark (%)</label>
          <input id="up-pass" name="pass_threshold" type="number" min="0" max="100" value="80">
        </div>
      </div>

      <div class="field">
        <label class="check">
          <input type="checkbox" name="require_final_exam" value="true">
          <span>Add a cumulative final exam
            <span class="faint" style="display:block">Leave off when the quizzes alone are the point — for example, confirming someone sat through the video.</span>
          </span>
        </label>
      </div>

      <div id="up-error"></div>
      <div class="row row-end">
        <button type="button" id="up-cancel">Cancel</button>
        <button class="primary" type="submit">Generate course</button>
      </div>
    </form>`);

  back.querySelector('#up-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#up-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const out = await api('/api/courses', {
        method: 'POST',
        body: new FormData(e.target),
        raw: true,
      });
      back.remove();
      location.hash = `#/courses/${out.course_id}`;
    } catch (err) {
      back.querySelector('#up-error').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Generate course';
    }
  });
}

/* ====================================================== course editor */

let jobPoll = null;

async function viewCourseEditor(id) {
  clearInterval(jobPoll);
  const data = await api(`/api/courses/${id}`);
  const c = data.course;

  if (c.status === 'generating') return renderGenerating(c);

  const questionBlock = (q, i, sectionId) => `
    <div class="question" data-qid="${q.id}">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div class="qnum">Question ${i + 1} · ${esc(q.type.replace('_', ' '))}</div>
        <div class="row">
          <button class="small ghost" data-edit-q="${q.id}" data-section="${sectionId ?? ''}">Edit</button>
          <button class="small ghost danger" data-del-q="${q.id}">Delete</button>
        </div>
      </div>
      <div class="qprompt">${esc(q.prompt)}</div>
      <div class="options">
        ${q.options
          .map(
            (o, oi) =>
              `<div class="option ${q.correct.includes(oi) ? 'correct' : ''}">
                 <span style="font-weight:700;min-width:1.2em">${String.fromCharCode(65 + oi)}</span>
                 <span>${esc(o)}</span>
               </div>`
          )
          .join('')}
      </div>
      ${q.explanation ? `<div class="explain">${esc(q.explanation)}</div>` : ''}
    </div>`;

  render(`
  <main class="page page-wide">
    <div class="page-head">
      <div class="grow">
        <a class="faint" href="#/courses" style="text-decoration:none">← All courses</a>
        <h1 style="margin-top:6px">${esc(c.title)}</h1>
        <p>${data.sections.length} sections · ${data.sections.reduce((n, s) => n + s.questions.length, 0)} section questions${c.require_final_exam ? ` · ${data.final_exam.length}-question final exam` : ''}</p>
      </div>
      <div class="row">
        ${c.status === 'published'
          ? `<span class="badge good">Published</span><button id="btn-unpublish">Unpublish</button>`
          : `<button class="primary" id="btn-publish">Publish course</button>`}
      </div>
    </div>

    ${c.status === 'failed' ? `<div class="notice bad" style="margin-bottom:20px">The last generation failed. Fix the source file or try again with <em>Regenerate</em>.</div>` : ''}

    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(280px,1fr);align-items:start">
      <div class="stack">
        ${data.sections
          .map(
            (s, si) => `
          <div class="card stack" data-section-card="${s.id}">
            <div class="card-head">
              <div class="grow">
                <div class="faint">Section ${si + 1}${s.source_ref ? ` · ${esc(s.source_ref)}` : ''}</div>
                <h2 style="margin:2px 0 0">${esc(s.title)}</h2>
                ${s.summary ? `<p class="muted" style="margin:6px 0 0;font-size:14px">${esc(s.summary)}</p>` : ''}
              </div>
              <div class="row">
                <button class="small" data-edit-section="${s.id}">Edit content</button>
                <button class="small ghost danger" data-del-section="${s.id}">Delete</button>
              </div>
            </div>

            <div class="row faint">
              <span>⏱ Minimum ${clock(s.min_seconds)} on this section before the quiz unlocks</span>
              ${s.video_url ? `<span>· 🎬 video attached</span>` : ''}
            </div>

            <details>
              <summary style="cursor:pointer;color:var(--text-dim);font-size:14px">Preview learner content</summary>
              <div class="reader" style="margin-top:12px">${md(s.content)}</div>
            </details>

            <div>
              <div class="row" style="justify-content:space-between;margin-bottom:10px">
                <h3 style="margin:0">Quiz · ${plural(s.questions.length, 'question')}</h3>
                <div class="row">
                  <button class="small" data-add-q="${s.id}">Add question</button>
                  <button class="small" data-regen="${s.id}">Regenerate quiz</button>
                </div>
              </div>
              ${s.questions.length
                ? s.questions.map((q, qi) => questionBlock(q, qi, s.id)).join('')
                : `<div class="notice warn">This section has no questions, so it cannot gate anything. Add or generate some before publishing.</div>`}
            </div>
          </div>`
          )
          .join('')}

        <div class="card stack">
          <div class="card-head">
            <div class="grow">
              <h2 style="margin:0">Final exam</h2>
              <p class="muted" style="margin:4px 0 0;font-size:14px">
                ${c.require_final_exam
                  ? 'Learners must pass this after every section is complete.'
                  : 'Switched off. Section quizzes alone decide completion.'}
              </p>
            </div>
            <button class="small" data-regen="">${data.final_exam.length ? 'Regenerate exam' : 'Generate exam'}</button>
          </div>
          ${data.final_exam.length
            ? data.final_exam.map((q, qi) => questionBlock(q, qi, null)).join('')
            : `<div class="empty" style="padding:24px">No final exam questions yet.</div>`}
        </div>
      </div>

      <div class="stack" style="position:sticky;top:80px">
        <div class="card stack">
          <h3 style="margin:0">Gate settings</h3>
          <form id="settings-form" class="stack">
            <div class="field" style="margin:0">
              <label for="f-pass">Section pass mark (%)</label>
              <input id="f-pass" name="pass_threshold" type="number" min="0" max="100" value="${c.pass_threshold}">
              <div class="field-hint">Score needed to unlock the next section.</div>
            </div>

            <div class="field" style="margin:0">
              <label for="f-attempts">Attempts allowed</label>
              <input id="f-attempts" name="max_attempts" type="number" min="0" max="20" value="${c.max_attempts}">
              <div class="field-hint">0 = unlimited retries.</div>
            </div>

            <div class="field" style="margin:0">
              <label for="f-cooldown">Cooldown between attempts (seconds)</label>
              <input id="f-cooldown" name="retry_cooldown_sec" type="number" min="0" max="86400" value="${c.retry_cooldown_sec}">
              <div class="field-hint">0 = retry immediately. 300 makes people re-read.</div>
            </div>

            <label class="check">
              <input type="checkbox" name="require_final_exam" ${c.require_final_exam ? 'checked' : ''}>
              <span>Require a final exam</span>
            </label>

            <div class="field" style="margin:0">
              <label for="f-finalpass">Final exam pass mark (%)</label>
              <input id="f-finalpass" name="final_pass_threshold" type="number" min="0" max="100" value="${c.final_pass_threshold}">
            </div>

            <label class="check">
              <input type="checkbox" name="shuffle_questions" ${c.shuffle_questions ? 'checked' : ''}>
              <span>Shuffle question order</span>
            </label>

            <label class="check">
              <input type="checkbox" name="certificate_enabled" ${c.certificate_enabled ? 'checked' : ''}>
              <span>Issue a certificate on completion</span>
            </label>

            <label class="check">
              <input type="checkbox" name="open_enrollment" ${c.open_enrollment ? 'checked' : ''}>
              <span>Let anyone in the company self-enroll
                <span class="faint" style="display:block">Otherwise it must be assigned.</span>
              </span>
            </label>

            <button class="primary block" type="submit">Save settings</button>
          </form>
        </div>

        <div class="card stack">
          <h3 style="margin:0">Description</h3>
          <textarea id="f-desc" rows="4">${esc(c.description)}</textarea>
          <button id="btn-save-desc">Save description</button>
        </div>

        <div class="card stack">
          <h3 style="margin:0">Source</h3>
          <p class="faint" style="margin:0">${esc(c.source_filename || 'No file on record')}</p>
          <button id="btn-regen-all">Regenerate whole course</button>
          <p class="faint" style="margin:0">Re-runs the pipeline from the original file. Replaces all sections and questions.</p>
        </div>
      </div>
    </div>
  </main>`);

  wireEditor(id, data);
}

function renderGenerating(course) {
  render(`
  <main class="page page-narrow">
    <div class="card stack" style="text-align:center;padding:40px">
      <h1 style="margin:0">Building “${esc(course.title)}”</h1>
      <p class="muted" style="margin:0">Claude is reading your deck, splitting it into sections, and writing a quiz for each one. This usually takes one to three minutes.</p>
      <div class="bar" style="margin:8px 0"><span id="job-bar" style="width:5%"></span></div>
      <p id="job-msg" class="muted" style="margin:0">Starting…</p>
      <div class="stepper" style="text-align:left;max-width:340px;margin:12px auto 0">
        <div class="step" data-step="extract"><span class="idx">1</span><span>Reading the document</span></div>
        <div class="step" data-step="sectioning"><span class="idx">2</span><span>Splitting into sections</span></div>
        <div class="step" data-step="quizzes"><span class="idx">3</span><span>Writing section quizzes</span></div>
        <div class="step" data-step="final_exam"><span class="idx">4</span><span>Writing the final exam</span></div>
      </div>
      <div id="job-error"></div>
    </div>
  </main>`);

  const order = ['extract', 'sectioning', 'quizzes', 'final_exam'];
  clearInterval(jobPoll);
  jobPoll = setInterval(async () => {
    try {
      const { job } = await api(`/api/courses/${course.id}/job`);
      if (!job) return;

      document.getElementById('job-bar').style.width = `${Math.max(5, job.progress)}%`;
      document.getElementById('job-msg').textContent = job.message || job.stage;

      const at = order.indexOf(job.stage);
      document.querySelectorAll('.step').forEach((el) => {
        const i = order.indexOf(el.dataset.step);
        el.className = `step ${i < at || job.status === 'done' ? 'ok' : i === at ? 'on' : ''}`;
      });

      if (job.status === 'done') {
        clearInterval(jobPoll);
        toast('Course generated. Review it before publishing.', 'good');
        viewCourseEditor(course.id);
      } else if (job.status === 'failed') {
        clearInterval(jobPoll);
        document.getElementById('job-error').innerHTML =
          `<div class="notice bad" style="text-align:left">${esc(job.error || 'Generation failed.')}</div>
           <div class="row row-end" style="margin-top:12px">
             <a class="button" href="#/courses">Back to courses</a>
             <button class="primary" id="job-retry">Try again</button>
           </div>`;
        document.getElementById('job-retry')?.addEventListener('click', async () => {
          try {
            await api(`/api/courses/${course.id}/regenerate`, { method: 'POST' });
            viewCourseEditor(course.id);
          } catch (err) {
            toast(err.message, 'bad');
          }
        });
      }
    } catch {
      /* transient — keep polling */
    }
  }, 1500);
}

function wireEditor(id, data) {
  const reload = () => viewCourseEditor(id);
  const guard = async (btn, fn) => {
    btn.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, 'bad'); } finally { btn.disabled = false; }
  };

  document.getElementById('btn-publish')?.addEventListener('click', (e) =>
    guard(e.target, async () => {
      await api(`/api/courses/${id}/publish`, { method: 'POST' });
      toast('Published. You can assign it from the Team page.', 'good');
      reload();
    })
  );

  document.getElementById('btn-unpublish')?.addEventListener('click', (e) =>
    guard(e.target, async () => {
      await api(`/api/courses/${id}/unpublish`, { method: 'POST' });
      reload();
    })
  );

  document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/api/courses/${id}`, {
        method: 'PATCH',
        body: {
          pass_threshold: Number(f.get('pass_threshold')),
          max_attempts: Number(f.get('max_attempts')),
          retry_cooldown_sec: Number(f.get('retry_cooldown_sec')),
          final_pass_threshold: Number(f.get('final_pass_threshold')),
          require_final_exam: f.get('require_final_exam') === 'on',
          shuffle_questions: f.get('shuffle_questions') === 'on',
          certificate_enabled: f.get('certificate_enabled') === 'on',
          open_enrollment: f.get('open_enrollment') === 'on',
        },
      });
      toast('Settings saved.', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  document.getElementById('btn-save-desc')?.addEventListener('click', (e) =>
    guard(e.target, async () => {
      await api(`/api/courses/${id}`, {
        method: 'PATCH',
        body: { description: document.getElementById('f-desc').value },
      });
      toast('Description saved.', 'good');
    })
  );

  document.getElementById('btn-regen-all')?.addEventListener('click', (e) =>
    guard(e.target, async () => {
      if (!confirm('Re-run generation from the original file? All current sections and questions are replaced.')) return;
      await api(`/api/courses/${id}/regenerate`, { method: 'POST' });
      viewCourseEditor(id);
    })
  );

  document.querySelectorAll('[data-regen]').forEach((b) =>
    b.addEventListener('click', () =>
      guard(b, async () => {
        const sectionId = b.dataset.regen ? Number(b.dataset.regen) : null;
        b.textContent = 'Generating…';
        await api(`/api/courses/${id}/generate-questions`, {
          method: 'POST',
          body: sectionId ? { section_id: sectionId } : {},
        });
        toast('Questions regenerated.', 'good');
        reload();
      })
    )
  );

  document.querySelectorAll('[data-del-q]').forEach((b) =>
    b.addEventListener('click', () =>
      guard(b, async () => {
        if (!confirm('Delete this question?')) return;
        await api(`/api/courses/${id}/questions/${b.dataset.delQ}`, { method: 'DELETE' });
        reload();
      })
    )
  );

  document.querySelectorAll('[data-del-section]').forEach((b) =>
    b.addEventListener('click', () =>
      guard(b, async () => {
        if (!confirm('Delete this section and its questions?')) return;
        await api(`/api/courses/${id}/sections/${b.dataset.delSection}`, { method: 'DELETE' });
        reload();
      })
    )
  );

  document.querySelectorAll('[data-edit-section]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = data.sections.find((x) => x.id === Number(b.dataset.editSection));
      sectionModal(id, s, reload);
    })
  );

  document.querySelectorAll('[data-edit-q]').forEach((b) =>
    b.addEventListener('click', () => {
      const qid = Number(b.dataset.editQ);
      const q =
        data.sections.flatMap((s) => s.questions).find((x) => x.id === qid) ||
        data.final_exam.find((x) => x.id === qid);
      questionModal(id, q, null, reload);
    })
  );

  document.querySelectorAll('[data-add-q]').forEach((b) =>
    b.addEventListener('click', () => questionModal(id, null, Number(b.dataset.addQ), reload))
  );
}

function sectionModal(courseId, section, done) {
  const back = modal(`
    <h2>Edit section</h2>
    <form id="sec-form" class="stack">
      <div class="field"><label for="s-title">Title</label>
        <input id="s-title" name="title" value="${attr(section.title)}" required></div>
      <div class="field"><label for="s-summary">One-line summary</label>
        <input id="s-summary" name="summary" value="${attr(section.summary)}"></div>
      <div class="field"><label for="s-video">Video URL <span class="faint">(optional)</span></label>
        <input id="s-video" name="video_url" type="url" value="${attr(section.video_url || '')}" placeholder="https://youtube.com/watch?v=…">
        <div class="field-hint">YouTube, Vimeo, or a direct .mp4. Shown above the reading content.</div></div>
      <div class="field"><label for="s-min">Minimum time on this section (seconds)</label>
        <input id="s-min" name="min_seconds" type="number" min="0" max="7200" value="${section.min_seconds}">
        <div class="field-hint">The quiz stays locked until the learner has spent this long here. For a video, set it to roughly its length.</div></div>
      <div class="field"><label for="s-content">Learner content (Markdown)</label>
        <textarea id="s-content" name="content" class="tall">${esc(section.content)}</textarea></div>
      <div class="row row-end">
        <button type="button" id="sec-cancel">Cancel</button>
        <button class="primary" type="submit">Save section</button>
      </div>
    </form>`);

  back.querySelector('#sec-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#sec-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api(`/api/courses/${courseId}/sections/${section.id}`, {
        method: 'PATCH',
        body: { ...f, min_seconds: Number(f.min_seconds) },
      });
      back.remove();
      toast('Section saved.', 'good');
      done();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

function questionModal(courseId, question, sectionId, done) {
  const opts = question ? question.options : ['', '', '', ''];
  const correct = question ? question.correct : [];

  const optionRow = (text, i) => `
    <div class="row" style="flex-wrap:nowrap;margin-bottom:8px" data-opt-row>
      <input type="checkbox" data-correct="${i}" ${correct.includes(i) ? 'checked' : ''}
             style="width:auto;accent-color:var(--accent)" title="Mark correct">
      <input type="text" data-opt value="${attr(text)}" placeholder="Option ${String.fromCharCode(65 + i)}">
      <button type="button" class="small ghost danger" data-rm-opt>✕</button>
    </div>`;

  const back = modal(`
    <h2>${question ? 'Edit question' : 'New question'}</h2>
    <form id="q-form" class="stack">
      <div class="field"><label for="q-prompt">Question</label>
        <textarea id="q-prompt" name="prompt" rows="2" required>${esc(question?.prompt || '')}</textarea></div>

      <div class="field">
        <label>Options <span class="faint">— tick every correct one</span></label>
        <div id="q-opts">${opts.map(optionRow).join('')}</div>
        <button type="button" class="small" id="q-add-opt">Add option</button>
      </div>

      <div class="field"><label for="q-exp">Explanation shown after answering</label>
        <textarea id="q-exp" name="explanation" rows="2">${esc(question?.explanation || '')}</textarea></div>

      <div id="q-error"></div>
      <div class="row row-end">
        <button type="button" id="q-cancel">Cancel</button>
        <button class="primary" type="submit">Save question</button>
      </div>
    </form>`);

  const reindex = () => {
    back.querySelectorAll('[data-opt-row]').forEach((row, i) => {
      row.querySelector('[data-correct]').dataset.correct = String(i);
      row.querySelector('[data-opt]').placeholder = `Option ${String.fromCharCode(65 + i)}`;
    });
  };

  back.addEventListener('click', (e) => {
    if (e.target.matches('[data-rm-opt]')) {
      if (back.querySelectorAll('[data-opt-row]').length <= 2) {
        toast('A question needs at least two options.', 'bad');
        return;
      }
      e.target.closest('[data-opt-row]').remove();
      reindex();
    }
  });

  back.querySelector('#q-add-opt').addEventListener('click', () => {
    const n = back.querySelectorAll('[data-opt-row]').length;
    back.querySelector('#q-opts').insertAdjacentHTML('beforeend', optionRow('', n));
  });

  back.querySelector('#q-cancel').addEventListener('click', () => back.remove());

  back.querySelector('#q-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = [...back.querySelectorAll('[data-opt-row]')];
    const options = rows.map((r) => r.querySelector('[data-opt]').value.trim());
    const correctIdx = rows
      .map((r, i) => (r.querySelector('[data-correct]').checked ? i : -1))
      .filter((i) => i >= 0);

    const body = {
      prompt: back.querySelector('#q-prompt').value,
      explanation: back.querySelector('#q-exp').value,
      options,
      correct: correctIdx,
      section_id: sectionId,
    };

    try {
      if (question) {
        await api(`/api/courses/${courseId}/questions/${question.id}`, { method: 'PATCH', body });
      } else {
        await api(`/api/courses/${courseId}/questions`, { method: 'POST', body });
      }
      back.remove();
      toast('Question saved.', 'good');
      done();
    } catch (err) {
      back.querySelector('#q-error').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });
}

/* ================================================================ team */

async function viewTeam() {
  const [team, { courses }, progress] = await Promise.all([
    api('/api/team'),
    api('/api/courses'),
    api('/api/team/progress'),
  ]);

  const published = courses.filter((c) => c.status === 'published');
  const seatsFree = team.org.seats - team.seats_used;

  render(`
  <main class="page page-wide">
    <div class="page-head">
      <div class="grow">
        <h1>${esc(team.org.name)}</h1>
        <p>Manage who is trained, on what, and prove it later.</p>
      </div>
      ${isAdmin() ? `<button class="primary" id="btn-add-member">Add employee</button>` : ''}
    </div>

    <div class="grid grid-3" style="margin-bottom:24px">
      <div class="stat"><div class="stat-value">${team.seats_used}<span class="muted" style="font-size:18px"> / ${team.org.seats}</span></div>
        <div class="stat-label">Seats used</div></div>
      <div class="stat"><div class="stat-value">${published.length}</div><div class="stat-label">Published courses</div></div>
      <div class="stat"><div class="stat-value">${progress.rows.filter((r) => r.status === 'completed').length}<span class="muted" style="font-size:18px"> / ${progress.rows.length}</span></div>
        <div class="stat-label">Assignments completed</div></div>
    </div>

    ${
      isAdmin()
        ? `<div class="card card-tight row" style="margin-bottom:24px;justify-content:space-between">
             <span class="muted">${seatsFree > 0 ? `${plural(seatsFree, 'seat')} free.` : 'All seats are in use.'}</span>
             <form id="seats-form" class="row" style="gap:8px">
               <input type="number" name="seats" min="1" value="${team.org.seats}" style="width:110px">
               <button type="submit">Update seats</button>
             </form>
           </div>`
        : ''
    }

    <div class="card" style="padding:8px;margin-bottom:28px">
      <div class="table-wrap"><table>
        <thead><tr><th>Employee</th><th>Role</th><th>Training</th><th>Status</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${team.members
            .map(
              (m) => `<tr>
                <td><strong>${esc(m.name)}</strong><div class="faint">${esc(m.email)}</div></td>
                <td class="muted">${esc(roleLabel(m.role))}</td>
                <td class="muted">${m.completed} of ${m.assigned} complete</td>
                <td>${m.active ? '<span class="badge good">Active</span>' : '<span class="badge">Deactivated</span>'}</td>
                ${isAdmin()
                  ? `<td style="text-align:right">
                       <button class="small ghost" data-toggle-member="${m.id}" data-active="${m.active}">
                         ${m.active ? 'Deactivate' : 'Reactivate'}
                       </button>
                     </td>`
                  : ''}
              </tr>`
            )
            .join('')}
        </tbody>
      </table></div>
    </div>

    <div class="card stack" style="margin-bottom:28px">
      <div class="card-head">
        <div class="grow"><h2 style="margin:0">Assign training</h2>
          <p class="muted" style="margin:4px 0 0;font-size:14px">Pick a published course and the people who need it.</p></div>
      </div>
      ${
        published.length === 0
          ? `<div class="notice warn">No published courses yet. <a href="#/courses">Create one</a> first.</div>`
          : `<form id="assign-form" class="stack">
               <div class="field" style="margin:0">
                 <label for="as-course">Course</label>
                 <select id="as-course" name="course_id">
                   ${published.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}
                 </select>
               </div>
               <div class="field" style="margin:0">
                 <label>People</label>
                 <div class="row" style="margin-bottom:8px">
                   <button type="button" class="small" id="as-all">Select everyone</button>
                   <button type="button" class="small ghost" id="as-none">Clear</button>
                 </div>
                 <div class="grid grid-3">
                   ${team.members
                     .filter((m) => m.active)
                     .map(
                       (m) => `<label class="check"><input type="checkbox" name="user_ids" value="${m.id}">
                                 <span>${esc(m.name)}<span class="faint" style="display:block">${esc(m.email)}</span></span></label>`
                     )
                     .join('')}
                 </div>
               </div>
               <div><button class="primary" type="submit">Assign</button></div>
             </form>`
      }
    </div>

    <h2>Progress</h2>
    ${
      progress.rows.length === 0
        ? `<div class="empty">Nothing assigned yet.</div>`
        : `<div class="card" style="padding:8px">
             <div class="table-wrap"><table>
               <thead><tr><th>Employee</th><th>Course</th><th>Progress</th><th>Status</th><th>Certificate</th><th></th></tr></thead>
               <tbody>
                 ${progress.rows
                   .map((r) => {
                     const pct = r.total_sections ? Math.round((r.passed_sections / r.total_sections) * 100) : 0;
                     return `<tr>
                       <td><strong>${esc(r.user_name)}</strong><div class="faint">${esc(r.email)}</div></td>
                       <td>${esc(r.course_title)}</td>
                       <td style="min-width:150px">
                         <div class="bar ${r.status === 'completed' ? 'good' : ''}"><span style="width:${pct}%"></span></div>
                         <div class="faint">${r.passed_sections}/${r.total_sections} sections</div>
                       </td>
                       <td>${
                         r.status === 'completed'
                           ? `<span class="badge good">Complete</span>${r.final_score != null ? `<div class="faint">${Math.round(r.final_score)}%</div>` : ''}`
                           : r.status === 'in_progress'
                             ? '<span class="badge accent">In progress</span>'
                             : '<span class="badge">Not started</span>'
                       }</td>
                       <td>${r.certificate_code ? `<a class="mono" href="/c/${esc(r.certificate_code)}" target="_blank" rel="noopener">${esc(r.certificate_code)}</a>` : '<span class="faint">—</span>'}</td>
                       <td style="text-align:right">
                         ${r.status !== 'completed' ? `<button class="small ghost danger" data-unassign="${r.enrollment_id}">Unassign</button>` : ''}
                       </td>
                     </tr>`;
                   })
                   .join('')}
               </tbody>
             </table></div>
           </div>`
    }
  </main>`);

  document.getElementById('btn-add-member')?.addEventListener('click', () => addMemberModal(viewTeam));

  document.getElementById('seats-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/team/seats', {
        method: 'PATCH',
        body: { seats: Number(new FormData(e.target).get('seats')) },
      });
      toast('Seat count updated.', 'good');
      viewTeam();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  document.getElementById('as-all')?.addEventListener('click', () =>
    document.querySelectorAll('input[name=user_ids]').forEach((c) => (c.checked = true))
  );
  document.getElementById('as-none')?.addEventListener('click', () =>
    document.querySelectorAll('input[name=user_ids]').forEach((c) => (c.checked = false))
  );

  document.getElementById('assign-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const ids = f.getAll('user_ids').map(Number);
    if (ids.length === 0) return toast('Pick at least one person.', 'bad');
    try {
      const out = await api('/api/team/assignments', {
        method: 'POST',
        body: { course_id: Number(f.get('course_id')), user_ids: ids },
      });
      toast(`Assigned to ${plural(out.assigned, 'person', 'people')}${out.skipped ? ` (${out.skipped} already had it)` : ''}.`, 'good');
      viewTeam();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  document.querySelectorAll('[data-unassign]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remove this assignment?')) return;
      try {
        await api(`/api/team/assignments/${b.dataset.unassign}`, { method: 'DELETE' });
        viewTeam();
      } catch (err) {
        toast(err.message, 'bad');
      }
    })
  );

  document.querySelectorAll('[data-toggle-member]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/team/members/${b.dataset.toggleMember}`, {
          method: 'PATCH',
          body: { active: b.dataset.active !== '1' },
        });
        viewTeam();
      } catch (err) {
        toast(err.message, 'bad');
      }
    })
  );
}

function addMemberModal(done) {
  const back = modal(`
    <h2>Add an employee</h2>
    <p class="muted">They get a one-time password you pass on. There is no mail server in this deployment, so it is shown here once.</p>
    <form id="mem-form" class="stack" style="margin-top:16px">
      <div class="field"><label for="m-name">Name</label><input id="m-name" name="name" required></div>
      <div class="field"><label for="m-email">Email</label><input id="m-email" name="email" type="email" required></div>
      <div class="field"><label for="m-role">Role</label>
        <select id="m-role" name="role">
          <option value="learner">Learner — takes assigned training</option>
          <option value="instructor">Instructor — can also build courses</option>
          <option value="org_admin">Administrator — full company access</option>
        </select></div>
      <div id="m-error"></div>
      <div class="row row-end">
        <button type="button" id="m-cancel">Cancel</button>
        <button class="primary" type="submit">Add employee</button>
      </div>
    </form>`);

  back.querySelector('#m-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#mem-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await api('/api/team/members', {
        method: 'POST',
        body: Object.fromEntries(new FormData(e.target)),
      });
      back.querySelector('.modal').innerHTML = `
        <h2>${esc(out.member.name)} added</h2>
        <p class="muted">Give them these credentials. The password is not recoverable — you can set a new one later if it is lost.</p>
        <div class="notice" style="margin:16px 0">
          <div><span class="faint">Email</span><div class="mono">${esc(out.member.email)}</div></div>
          <div style="margin-top:10px"><span class="faint">Temporary password</span>
            <div class="mono" style="font-size:16px;user-select:all">${esc(out.temporary_password)}</div></div>
        </div>
        <div class="row row-end"><button class="primary" id="m-done">Done</button></div>`;
      back.querySelector('#m-done').addEventListener('click', () => { back.remove(); done(); });
    } catch (err) {
      back.querySelector('#m-error').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });
}

/* ============================================================== player */

const player = { enrollmentId: null, state: null, view: 'overview', sectionId: null, heartbeat: null, result: null };

function stopHeartbeat() {
  clearInterval(player.heartbeat);
  player.heartbeat = null;
}

async function viewPlayer(enrollmentId) {
  stopHeartbeat();
  player.enrollmentId = enrollmentId;
  player.state = await api(`/api/learn/${enrollmentId}`);
  player.view = 'overview';
  renderPlayer();
}

function renderPlayer() {
  const s = player.state;
  const passed = s.sections.filter((x) => x.passed).length;
  const pct = s.sections.length ? Math.round((passed / s.sections.length) * 100) : 0;

  const sidebar = `
    <div class="stack" style="position:sticky;top:80px">
      <div class="card stack">
        <div>
          <div class="bar ${s.complete ? 'good' : ''}"><span style="width:${pct}%"></span></div>
          <p class="faint" style="margin:8px 0 0">${passed} of ${s.sections.length} sections passed</p>
        </div>
        <div class="sectionlist">
          ${s.sections
            .map((sec) => {
              const cur = player.view !== 'overview' && sec.id === player.sectionId;
              return `<button class="sectionitem ${cur ? 'current' : ''}" data-open-section="${sec.id}" ${sec.locked ? 'disabled' : ''}>
                <span class="stepdot ${sec.passed ? 'done' : cur ? 'current' : ''}">${sec.passed ? '✓' : sec.locked ? '🔒' : sec.position}</span>
                <span class="grow">
                  <span class="t">${esc(sec.title)}</span>
                  <span class="s">${
                    sec.passed
                      ? `Passed · ${Math.round(sec.best_score)}%`
                      : sec.locked
                        ? 'Locked'
                        : sec.content_done
                          ? 'Quiz ready'
                          : `${clock(Math.max(0, sec.min_seconds - sec.seconds_spent))} left to read`
                  }</span>
                </span>
              </button>`;
            })
            .join('')}
          ${
            s.final_exam.required
              ? `<button class="sectionitem ${player.view === 'final' ? 'current' : ''}" data-open-final ${s.final_exam.unlocked ? '' : 'disabled'}>
                   <span class="stepdot ${s.final_exam.passed ? 'done' : ''}">${s.final_exam.passed ? '✓' : '★'}</span>
                   <span class="grow"><span class="t">Final exam</span>
                     <span class="s">${
                       s.final_exam.passed
                         ? `Passed · ${Math.round(s.final_exam.best_score)}%`
                         : s.final_exam.unlocked
                           ? `${plural(s.final_exam.question_count, 'question')}`
                           : 'Pass every section first'
                     }</span></span>
                 </button>`
              : ''
          }
        </div>
      </div>
    </div>`;

  let main = '';
  if (player.view === 'overview') main = playerOverview(s);
  else if (player.view === 'section') main = playerSection(s);
  else if (player.view === 'quiz') main = playerQuiz(s);
  else if (player.view === 'result') main = playerResult(s);
  else if (player.view === 'final') main = playerQuiz(s, true);

  render(`
  <main class="page page-wide">
    <div class="page-head">
      <div class="grow">
        <a class="faint" href="#/" style="text-decoration:none">← My training</a>
        <h1 style="margin-top:6px">${esc(s.course.title)}</h1>
      </div>
      ${s.complete ? '<span class="badge good">Complete</span>' : ''}
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(280px,340px);align-items:start">
      <div id="player-main">${main}</div>
      ${sidebar}
    </div>
  </main>`);

  wirePlayer();
}

function playerOverview(s) {
  const next = s.sections.find((x) => !x.passed && !x.locked);

  return `
    ${
      s.complete
        ? `<div class="card stack center" style="padding:36px">
             <div style="font-size:44px">🎉</div>
             <h2 style="margin:0">Training complete</h2>
             <p class="muted" style="margin:0">You passed every section${s.final_exam.required ? ' and the final exam' : ''}.</p>
             ${
               s.certificate
                 ? `<div class="row" style="justify-content:center">
                      <a class="button primary" href="/c/${esc(s.certificate.code)}" target="_blank" rel="noopener">View certificate ↗</a>
                    </div>
                    <p class="faint" style="margin:0">Certificate ID <span class="mono">${esc(s.certificate.code)}</span></p>`
                 : ''
             }
           </div>`
        : `<div class="card stack">
             ${s.course.description ? `<p class="muted" style="margin:0">${esc(s.course.description)}</p>` : ''}
             <div class="notice">
               <strong>How this works.</strong> Read each section, then pass its quiz to unlock the next one.
               You need <strong>${s.course.pass_threshold}%</strong> to pass${
                 s.course.max_attempts ? `, with ${plural(s.course.max_attempts, 'attempt')} per quiz` : ', with unlimited retries'
               }${s.course.retry_cooldown_sec ? ` and a ${clock(s.course.retry_cooldown_sec)} wait between attempts` : ''}.
               ${s.final_exam.required ? ` A final exam follows once every section is passed.` : ''}
             </div>
             ${
               next
                 ? `<div><button class="primary" data-open-section="${next.id}">
                      ${next.position === 1 && next.seconds_spent === 0 ? 'Start' : 'Continue'}: ${esc(next.title)}
                    </button></div>`
                 : s.final_exam.available
                   ? `<div><button class="primary" data-open-final>Take the final exam</button></div>`
                   : ''
             }
           </div>`
    }`;
}

function playerSection(s) {
  const sec = player.sectionData;
  const meta = s.sections.find((x) => x.id === sec.id);
  const remaining = Math.max(0, sec.min_seconds - meta.seconds_spent);

  return `
    <article class="card">
      <div class="faint">Section ${sec.position} of ${s.sections.length}${sec.source_ref ? ` · ${esc(sec.source_ref)}` : ''}</div>
      <h2 style="margin:6px 0 18px">${esc(sec.title)}</h2>
      ${sec.video_url ? videoEmbed(sec.video_url) : ''}
      <div class="reader">${md(sec.content)}</div>

      <div class="gatebar">
        ${
          meta.passed
            ? `<span class="badge good">Passed · ${Math.round(meta.best_score)}%</span>
               <span class="muted">You have already cleared this section.</span>
               <span class="spacer"></span>
               ${nextButton(s, sec)}`
            : `<div class="grow" style="min-width:200px">
                 <div class="bar"><span id="dwell-bar" style="width:${Math.min(100, (meta.seconds_spent / sec.min_seconds) * 100)}%"></span></div>
                 <p class="faint" style="margin:6px 0 0" id="dwell-text">
                   ${remaining > 0 ? `Quiz unlocks in ${clock(remaining)}` : 'Quiz unlocked'}
                 </p>
               </div>
               <button class="primary" id="btn-take-quiz" ${remaining > 0 ? 'disabled' : ''}>
                 Take the quiz · ${plural(meta.question_count, 'question')}
               </button>`
        }
      </div>
    </article>`;
}

function nextButton(s, sec) {
  const next = s.sections.find((x) => x.position === sec.position + 1);
  if (next && !next.locked) return `<button class="primary" data-open-section="${next.id}">Next section →</button>`;
  if (!next && s.final_exam.available) return `<button class="primary" data-open-final>Final exam →</button>`;
  return `<button class="primary" data-open-overview>Back to overview</button>`;
}

function playerQuiz(s, isFinal = false) {
  const q = player.quiz;
  if (!q) return `<div class="card"><p class="muted">Loading the quiz…</p></div>`;

  const title = isFinal
    ? 'Final exam'
    : `Quiz — ${esc(s.sections.find((x) => x.id === player.sectionId)?.title || '')}`;

  return `
    <form class="stack" id="quiz-form">
      <div class="card">
        <h2 style="margin:0 0 4px">${title}</h2>
        <p class="muted" style="margin:0">
          ${plural(q.questions.length, 'question')} · you need ${q.pass_threshold}% to pass.
          Answer every question, then submit.
        </p>
      </div>

      ${q.questions
        .map(
          (question, i) => `
        <div class="question">
          <div class="qnum">Question ${i + 1}${question.type === 'multiple_choice' ? ' · select all that apply' : ''}</div>
          <div class="qprompt">${esc(question.prompt)}</div>
          <div class="options">
            ${question.options
              .map(
                (o, oi) => `
              <label class="option">
                <input type="${question.type === 'multiple_choice' ? 'checkbox' : 'radio'}"
                       name="q${question.id}" value="${oi}">
                <span>${esc(o)}</span>
              </label>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}

      <div class="gatebar">
        <button type="button" class="ghost" data-open-overview>Cancel</button>
        <span class="spacer"></span>
        <span class="faint" id="quiz-count">0 of ${q.questions.length} answered</span>
        <button class="primary" type="submit">Submit answers</button>
      </div>
    </form>`;
}

function playerResult(s) {
  const r = player.result;
  const isFinal = r.isFinal;

  return `
    <div class="stack">
      <div class="scorehero ${r.passed ? 'pass' : 'fail'}">
        <div class="n">${Math.round(r.score)}%</div>
        <p class="muted" style="margin:10px 0 0">
          ${r.correct} of ${r.total} correct · ${r.pass_threshold}% needed
        </p>
        <h2 style="margin:14px 0 0">${r.passed ? (isFinal ? 'Final exam passed' : 'Section passed') : 'Not passed yet'}</h2>
        ${
          !r.passed
            ? `<p class="muted" style="margin:8px 0 0">Review the answers below, go back over the material, and try again.</p>`
            : ''
        }
      </div>

      ${
        r.passed && s.complete && s.certificate
          ? `<div class="notice good">
               <strong>Training complete.</strong> Your certificate is ready —
               <a href="/c/${esc(s.certificate.code)}" target="_blank" rel="noopener">open it</a>
               (ID <span class="mono">${esc(s.certificate.code)}</span>).
             </div>`
          : ''
      }

      <div class="card stack">
        <h3 style="margin:0">Your answers</h3>
        ${r.detail
          .map(
            (d, i) => `
          <div class="question">
            <div class="qnum">Question ${i + 1} · ${d.is_correct ? '<span style="color:var(--good)">Correct</span>' : '<span style="color:var(--bad)">Incorrect</span>'}</div>
            <div class="qprompt">${esc(d.prompt)}</div>
            <div class="options">
              ${d.options
                .map((o, oi) => {
                  const chosen = d.given.includes(oi);
                  const right = d.correct.includes(oi);
                  const cls = right ? 'correct' : chosen ? 'wrong' : '';
                  const mark = right ? '✓' : chosen ? '✗' : '';
                  return `<div class="option ${cls}">
                            <span style="min-width:1.2em;font-weight:700">${mark}</span>
                            <span>${esc(o)}</span>
                          </div>`;
                })
                .join('')}
            </div>
            ${d.explanation ? `<div class="explain">${esc(d.explanation)}</div>` : ''}
          </div>`
          )
          .join('')}
      </div>

      <div class="gatebar">
        <button data-open-overview>Course overview</button>
        <span class="spacer"></span>
        ${resultActions(s, r)}
      </div>
    </div>`;
}

function resultActions(s, r) {
  if (r.passed) {
    if (r.isFinal) return '';
    const sec = s.sections.find((x) => x.id === player.sectionId);
    const next = s.sections.find((x) => x.position === (sec?.position || 0) + 1);
    if (next && !next.locked) return `<button class="primary" data-open-section="${next.id}">Next section →</button>`;
    if (s.final_exam.available) return `<button class="primary" data-open-final>Final exam →</button>`;
    return '';
  }

  // Failed — surface the retry rules honestly.
  const meta = r.isFinal ? s.final_exam : s.sections.find((x) => x.id === player.sectionId);
  if (meta.attempts_left === 0) {
    return `<span class="badge bad">No attempts left — contact your administrator</span>`;
  }
  if (meta.cooldown_remaining > 0) {
    return `<span class="badge warn" id="cooldown-badge">Retry available in ${clock(meta.cooldown_remaining)}</span>`;
  }
  const left = meta.attempts_left === null ? '' : ` (${plural(meta.attempts_left, 'attempt')} left)`;
  return r.isFinal
    ? `<button class="primary" data-open-final>Retry the exam${left}</button>`
    : `<button data-open-section="${player.sectionId}">Re-read the section</button>
       <button class="primary" data-open-quiz="${player.sectionId}">Try again${left}</button>`;
}

function wirePlayer() {
  const go = (fn) => async (e) => {
    e.preventDefault();
    try { await fn(e); } catch (err) { toast(err.message, 'bad'); }
  };

  document.querySelectorAll('[data-open-overview]').forEach((b) =>
    b.addEventListener('click', go(async () => {
      stopHeartbeat();
      player.state = await api(`/api/learn/${player.enrollmentId}`);
      player.view = 'overview';
      renderPlayer();
    }))
  );

  document.querySelectorAll('[data-open-section]').forEach((b) =>
    b.addEventListener('click', go(async () => openSection(Number(b.dataset.openSection))))
  );

  document.querySelectorAll('[data-open-quiz]').forEach((b) =>
    b.addEventListener('click', go(async () => openQuiz(Number(b.dataset.openQuiz))))
  );

  document.querySelectorAll('[data-open-final]').forEach((b) =>
    b.addEventListener('click', go(async () => openQuiz(null, true)))
  );

  document.getElementById('btn-take-quiz')?.addEventListener('click', go(async () => openQuiz(player.sectionId)));

  // Live answered-count while taking a quiz.
  const form = document.getElementById('quiz-form');
  if (form) {
    const update = () => {
      const total = player.quiz.questions.length;
      const answered = player.quiz.questions.filter(
        (q) => form.querySelector(`input[name=q${q.id}]:checked`)
      ).length;
      const el = document.getElementById('quiz-count');
      if (el) el.textContent = `${answered} of ${total} answered`;
    };
    form.addEventListener('change', update);
    update();
    form.addEventListener('submit', go(submitQuiz));
  }

  // Cooldown countdown so the learner sees it tick down.
  const badge = document.getElementById('cooldown-badge');
  if (badge) {
    const meta = player.result.isFinal
      ? player.state.final_exam
      : player.state.sections.find((x) => x.id === player.sectionId);
    let left = meta.cooldown_remaining;
    const t = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(t);
        badge.outerHTML = player.result.isFinal
          ? `<button class="primary" data-open-final>Retry the exam</button>`
          : `<button class="primary" data-open-quiz="${player.sectionId}">Try again</button>`;
        wirePlayer();
      } else {
        badge.textContent = `Retry available in ${clock(left)}`;
      }
    }, 1000);
  }
}

async function openSection(sectionId) {
  stopHeartbeat();
  const { section } = await api(`/api/learn/${player.enrollmentId}/sections/${sectionId}`);
  player.sectionData = section;
  player.sectionId = sectionId;
  player.view = 'section';
  renderPlayer();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  startHeartbeat(sectionId);
}

/**
 * Reports reading time every 10s so the server can enforce the dwell gate.
 * Pauses when the tab is hidden — time spent on another tab is not reading.
 */
function startHeartbeat(sectionId) {
  const meta = player.state.sections.find((x) => x.id === sectionId);
  if (!meta || meta.passed) return;

  player.heartbeat = setInterval(async () => {
    if (document.hidden) return;
    try {
      const out = await api(`/api/learn/${player.enrollmentId}/heartbeat`, {
        method: 'POST',
        body: { section_id: sectionId, seconds: 10 },
      });
      meta.seconds_spent = out.seconds_spent;
      meta.content_done = out.content_done;

      const bar = document.getElementById('dwell-bar');
      const text = document.getElementById('dwell-text');
      const btn = document.getElementById('btn-take-quiz');
      if (bar) bar.style.width = `${Math.min(100, (out.seconds_spent / out.required) * 100)}%`;
      const remaining = Math.max(0, out.required - out.seconds_spent);
      if (text) text.textContent = remaining > 0 ? `Quiz unlocks in ${clock(remaining)}` : 'Quiz unlocked';
      if (btn && out.content_done) btn.disabled = false;
      if (out.content_done) stopHeartbeat();
    } catch {
      /* transient */
    }
  }, 10000);
}

async function openQuiz(sectionId, isFinal = false) {
  stopHeartbeat();
  player.quiz = null;
  player.sectionId = sectionId;
  player.isFinal = isFinal;
  player.view = isFinal ? 'final' : 'quiz';
  renderPlayer();

  const url = isFinal
    ? `/api/learn/${player.enrollmentId}/final-exam`
    : `/api/learn/${player.enrollmentId}/quiz/${sectionId}`;
  player.quiz = await api(url);
  renderPlayer();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submitQuiz(e) {
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const answers = {};
  let unanswered = 0;

  for (const q of player.quiz.questions) {
    const picked = [...form.querySelectorAll(`input[name=q${q.id}]:checked`)].map((i) => Number(i.value));
    if (picked.length === 0) unanswered++;
    answers[String(q.id)] = picked;
  }

  if (unanswered > 0 && !confirm(`${plural(unanswered, 'question')} unanswered — they will be marked wrong. Submit anyway?`)) {
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Marking…';

  const url = player.isFinal
    ? `/api/learn/${player.enrollmentId}/final-exam`
    : `/api/learn/${player.enrollmentId}/quiz/${player.sectionId}`;

  const out = await api(url, { method: 'POST', body: { answers } });
  player.result = { ...out, isFinal: player.isFinal };
  player.state = out.state;
  player.view = 'result';
  renderPlayer();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (out.passed) toast(player.isFinal ? 'Final exam passed.' : 'Section passed — next one unlocked.', 'good');
}

/* ============================================================== verify */

function viewVerify() {
  const inner = `
  <main class="page page-narrow">
    <div class="hero">
      <h1>Verify a certificate</h1>
      <p>Enter the certificate ID printed on a TrainGate certificate to confirm it is genuine.</p>
    </div>
    <div class="card stack">
      <form id="ver-form" class="row" style="flex-wrap:nowrap">
        <input name="code" placeholder="TG-XXXX-XXXX" required style="text-transform:uppercase" class="mono">
        <button class="primary" type="submit">Verify</button>
      </form>
      <div id="ver-out"></div>
    </div>
  </main>`;

  render(inner, { chrome: Boolean(state.user) });

  document.getElementById('ver-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code').trim().toUpperCase();
    const out = document.getElementById('ver-out');
    out.innerHTML = '<p class="muted">Checking…</p>';
    try {
      const res = await fetch(`/api/certificates/${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!data.valid) {
        out.innerHTML = `<div class="notice bad">No certificate matches <span class="mono">${esc(code)}</span>.</div>`;
        return;
      }
      const c = data.certificate;
      out.innerHTML = `
        <div class="notice good"><strong>Valid certificate.</strong></div>
        <table style="margin-top:16px">
          <tbody>
            <tr><td class="faint">Name</td><td><strong>${esc(c.learner_name)}</strong></td></tr>
            <tr><td class="faint">Course</td><td>${esc(c.course_title)}</td></tr>
            ${c.org_name ? `<tr><td class="faint">Organization</td><td>${esc(c.org_name)}</td></tr>` : ''}
            <tr><td class="faint">Issued</td><td>${esc(new Date(c.issued_at.replace(' ', 'T') + 'Z').toLocaleDateString())}</td></tr>
            ${c.score != null ? `<tr><td class="faint">Score</td><td>${Math.round(c.score)}%</td></tr>` : ''}
            <tr><td class="faint">Modules</td><td>${c.sections}</td></tr>
          </tbody>
        </table>
        <div class="row" style="margin-top:16px">
          <a class="button" href="/c/${esc(c.code)}" target="_blank" rel="noopener">Open the certificate ↗</a>
        </div>`;
    } catch {
      out.innerHTML = `<div class="notice bad">Could not reach the server.</div>`;
    }
  });
}

/* ============================================================== router */

async function route() {
  stopHeartbeat();
  clearInterval(jobPoll);

  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);

  // The verify page is public.
  if (parts[0] === 'verify') return viewVerify();

  if (!state.user) {
    if (parts[0] === 'signin') return renderAuth('login');
    if (parts[0] === 'signup') return renderAuth('register');
    return await viewLanding();
  }

  try {
    if (parts.length === 0) return await viewDashboard();
    if (parts[0] === 'courses' && parts[1]) return await viewCourseEditor(Number(parts[1]));
    if (parts[0] === 'courses') return isAuthor() ? await viewCourses() : await viewDashboard();
    if (parts[0] === 'team') return isAuthor() ? await viewTeam() : await viewDashboard();
    if (parts[0] === 'learn' && parts[1]) return await viewPlayer(Number(parts[1]));
    location.hash = '#/';
  } catch (err) {
    render(`
      <main class="page page-narrow">
        <div class="empty">
          <p><strong>${esc(err.message)}</strong></p>
          <a class="button" href="#/">Back to my training</a>
        </div>
      </main>`);
  }
}

window.addEventListener('hashchange', route);

(async function boot() {
  if (state.token) {
    try {
      const { user } = await api('/api/auth/me');
      state.user = user;
    } catch {
      state.token = null;
      localStorage.removeItem('tg_token');
    }
  }
  route();
})();
