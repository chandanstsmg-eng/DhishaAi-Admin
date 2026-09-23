'use strict';
/**
 * Deployment hardening: response headers, HTTPS detection and a login throttle.
 *
 * All of this is inert on a laptop and only tightens once the app is actually
 * served over TLS, so running locally behaves exactly as it did before.
 *
 * Environment:
 *   TRUST_PROXY=1     honour X-Forwarded-Proto (set ONLY behind a reverse proxy)
 *   SECURE_COOKIES=1  force the Secure flag even if the hop looks plain
 *   HSTS=1            send Strict-Transport-Security on HTTPS responses
 *   LOGIN_MAX_FAILS   failed sign-ins per window before a lockout (default 10)
 *   LOGIN_WINDOW_MIN  length of that window in minutes (default 15)
 */

const { HttpError } = require('./util');

const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const FORCE_SECURE = process.env.SECURE_COOKIES === '1';
const HSTS = process.env.HSTS === '1';

// ------------------------------------------------------------------- HTTPS
/**
 * Was this request served over TLS?
 *
 * X-Forwarded-Proto is a header like any other — a client can simply send it —
 * so it is believed only when TRUST_PROXY says a proxy is in front of us and is
 * the one writing it.
 */
function isSecureRequest(req) {
  if (FORCE_SECURE) return true;
  if (req.socket && req.socket.encrypted) return true;
  if (TRUST_PROXY) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto === 'https') return true;
  }
  return false;
}

// ----------------------------------------------------------------- headers
/*
 * The front end loads one module from its own origin and builds every node
 * through the DOM — no inline <script>, no inline style attribute, no CDN — so
 * the policy can stay strict without an 'unsafe-inline' escape hatch.
 *
 * img-src allows data: because an imported file is read to a data URL in the
 * browser before it is posted to /api/import/read.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** Security headers for every response, API and asset alike. */
function applyHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  // frame-ancestors above covers modern browsers; this covers the rest.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

  // Only meaningful on HTTPS, and actively harmful to send otherwise: a browser
  // that pins HSTS against a host with no certificate locks the office out.
  if (HSTS && isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
}

// ------------------------------------------------------------ login throttle
const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 10;
const WINDOW_MS = (Number(process.env.LOGIN_WINDOW_MIN) || 15) * 60000;

/**
 * Failed sign-ins per (IP + email), in memory.
 *
 * Deliberately not in SQLite: a lockout is worth nothing after a restart if the
 * attacker can simply cause one, and a write per guess is a free way to let an
 * attacker grow the database. The map is small, self-pruning and dies with the
 * process, which is exactly the lifetime a lockout wants.
 */
const fails = new Map();

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const keyFor = (req, email) => `${clientIp(req)}|${String(email || '').toLowerCase()}`;

/** Drop entries whose window has passed, so the map cannot grow without bound. */
function prune(now = Date.now()) {
  for (const [k, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(k);
}

/**
 * Throws 429 when this IP/email pair has burned through its attempts.
 * Call before checking the password.
 */
function checkLoginAllowed(req, email) {
  const now = Date.now();
  if (fails.size > 5000) prune(now);

  const entry = fails.get(keyFor(req, email));
  if (!entry) return;
  if (now - entry.first > WINDOW_MS) return;          // window rolled over
  if (entry.count < MAX_FAILS) return;

  const retryAfter = Math.ceil((entry.first + WINDOW_MS - now) / 1000);
  const err = new HttpError(
    429,
    `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
  );
  err.retryAfter = retryAfter;
  throw err;
}

/** Record a failed sign-in. */
function recordLoginFailure(req, email) {
  const now = Date.now();
  const key = keyFor(req, email);
  const entry = fails.get(key);
  if (!entry || now - entry.first > WINDOW_MS) fails.set(key, { count: 1, first: now });
  else entry.count += 1;
}

/** Clear the counter — the password was right. */
function recordLoginSuccess(req, email) {
  fails.delete(keyFor(req, email));
}

setInterval(() => prune(), WINDOW_MS).unref();

module.exports = {
  isSecureRequest, applyHeaders, CSP,
  checkLoginAllowed, recordLoginFailure, recordLoginSuccess,
  clientIp,
  config: { TRUST_PROXY, FORCE_SECURE, HSTS, MAX_FAILS, WINDOW_MS },
};
