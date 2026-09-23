'use strict';
/** Password hashing, cookie sessions, role gates and the audit trail. */

const crypto = require('crypto');
const { db } = require('./db');
const { nowIso, unauthorized, forbidden } = require('./util');

const COOKIE = 'dhishaai_sid';
const SESSION_DAYS = 7;

// ------------------------------------------------------------- passwords
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// -------------------------------------------------------------- sessions
function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.run(
    `INSERT INTO sessions (token, user_id, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [token, userId, String(userAgent || '').slice(0, 250), nowIso(), expires],
  );
  return { token, expires };
}

function destroySession(token) {
  if (token) db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

function purgeExpiredSessions() {
  db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const raw = part.slice(i + 1).trim();
    // On localhost every port shares one cookie jar, so a value written by
    // some unrelated project can land here. A bad escape in it must not cost
    // us the request — keep the raw text and carry on.
    let value;
    try { value = decodeURIComponent(raw); } catch (_) { value = raw; }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

/*
 * `secure` is passed in rather than read from config here, because it is a
 * property of the request that is being answered, not of the install: the same
 * server can be reached over TLS through the proxy and over plain HTTP from the
 * machine itself. Setting Secure on a plain hop would make the browser withhold
 * the cookie and the sign-in would silently never stick.
 */
function sessionCookie(token, expires, secure = false) {
  const bits = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

const clearCookie = (secure = false) =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax`
  + (secure ? '; Secure' : '')
  + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

/** Resolve the signed-in user from the request, or null. */
function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.get(
    `SELECT u.id, u.name, u.email, u.role, u.active, s.token, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    [token],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  if (!row.active) return null;
  return row;
}

// ----------------------------------------------------------------- roles
/**
 * Capability map. `owner` implicitly has everything.
 *   manage:*   -> write access to that module
 *   view:*     -> read access
 */
const ROLE_RANK = { owner: 4, admin: 3, accounts: 2, counsellor: 2, staff: 1 };

const WRITE_SCOPES = {
  owner:      ['*'],
  admin:      ['*'],
  accounts:   ['payments', 'installments', 'fees', 'expenses', 'students', 'enrollments', 'reports', 'tasks'],
  counsellor: ['enquiries', 'followups', 'students', 'enrollments', 'tasks', 'placements'],
  staff:      ['attendance', 'tasks', 'followups'],
};

function canWrite(user, scope) {
  if (!user) return false;
  const scopes = WRITE_SCOPES[user.role] || [];
  return scopes.includes('*') || scopes.includes(scope);
}

/** Throws unless the user may write to `scope`. */
function requireWrite(user, scope) {
  if (!user) throw unauthorized();
  if (!canWrite(user, scope)) {
    throw forbidden(`Your role (${user.role}) cannot modify ${scope}.`);
  }
}

/** Throws unless the user's role ranks at or above `role`. */
function requireRole(user, role) {
  if (!user) throw unauthorized();
  if ((ROLE_RANK[user.role] || 0) < (ROLE_RANK[role] || 99)) {
    throw forbidden(`This action needs ${role} access.`);
  }
}

// ----------------------------------------------------------------- audit
function audit(user, action, entity, entityId, detail) {
  db.run(
    `INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      user ? user.id : null,
      user ? user.name : 'system',
      action,
      entity,
      entityId == null ? null : String(entityId),
      detail == null ? null : String(detail).slice(0, 500),
      nowIso(),
    ],
  );
}

module.exports = {
  COOKIE, SESSION_DAYS,
  hashPassword, verifyPassword,
  createSession, destroySession, purgeExpiredSessions,
  parseCookies, sessionCookie, clearCookie,
  currentUser, canWrite, requireWrite, requireRole, audit,
  ROLE_RANK, WRITE_SCOPES,
};
