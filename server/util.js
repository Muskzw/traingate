'use strict';

const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const bad = (msg, details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Not signed in') => new HttpError(401, msg);
const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

/** Wraps an async route handler so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Human-friendly certificate code, e.g. TG-4F2K-9QX7. */
function certificateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `TG-${block()}-${block()}`;
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/** Coerce to an integer inside [min, max], falling back to `dflt`. */
function clampInt(value, min, max, dflt) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

module.exports = {
  HttpError,
  bad,
  unauthorized,
  forbidden,
  notFound,
  wrap,
  hashPassword,
  verifyPassword,
  randomToken,
  certificateCode,
  escapeHtml,
  clampInt,
  nowIso,
};
