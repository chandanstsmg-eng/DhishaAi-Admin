'use strict';
/** Sign-in, session, and admin-user management. */

const { db } = require('../db');
const auth = require('../auth');
const security = require('../security');
const {
  required, str, nowIso, badRequest, notFound, conflict, isEmail, oneOf, bool,
} = require('../util');

const ROLES = ['owner', 'admin', 'accounts', 'counsellor', 'staff'];
const SAFE = 'id, name, email, phone, role, active, last_login_at, created_at';

module.exports = function register(router) {
  // ---------------------------------------------------------- session
  router.post('/api/auth/login', ({ body, req, setCookie, secure }) => {
    required(body, ['email', 'password']);
    const email = str(body.email).toLowerCase();

    // Refuse before doing any work: the scrypt verify below is deliberately
    // expensive, so an unthrottled guess is also a free way to load the server.
    security.checkLoginAllowed(req, email);

    const user = db.get('SELECT * FROM users WHERE lower(email) = ?', [email]);

    // Same message either way — do not reveal which half was wrong.
    const fail = badRequest('Email or password is incorrect');
    if (!user) { security.recordLoginFailure(req, email); throw fail; }
    if (!auth.verifyPassword(body.password, user.salt, user.password_hash)) {
      security.recordLoginFailure(req, email);
      throw fail;
    }
    if (!user.active) throw badRequest('This account has been deactivated. Ask an admin to re-enable it.');

    security.recordLoginSuccess(req, email);
    const { token, expires } = auth.createSession(user.id, req.headers['user-agent']);
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
    auth.audit(user, 'login', 'users', user.id, null);
    setCookie(auth.sessionCookie(token, expires, secure));

    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  }, { public: true });

  router.post('/api/auth/logout', ({ req, user, setCookie, secure }) => {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    auth.destroySession(token);
    if (user) auth.audit(user, 'logout', 'users', user.id, null);
    setCookie(auth.clearCookie(secure));
    return { ok: true };
  }, { public: true });

  router.get('/api/auth/me', ({ user }) => {
    if (!user) return { user: null };
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      scopes: auth.WRITE_SCOPES[user.role] || [],
    };
  }, { public: true });

  router.post('/api/auth/password', ({ user, body }) => {
    required(body, ['current_password', 'new_password']);
    if (str(body.new_password).length < 8) {
      throw badRequest('New password must be at least 8 characters', {
        new_password: 'Use 8 characters or more',
      });
    }
    const row = db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    if (!auth.verifyPassword(body.current_password, row.salt, row.password_hash)) {
      throw badRequest('Current password is incorrect', { current_password: 'Incorrect' });
    }
    const { hash, salt } = auth.hashPassword(body.new_password);
    db.run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, user.id]);
    // Force a fresh sign-in everywhere else.
    db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    auth.audit(user, 'update', 'users', user.id, 'changed own password');
    return { ok: true, reauth: true };
  });

  // ------------------------------------------------------------ users
  router.get('/api/users', ({ user }) => {
    auth.requireRole(user, 'admin');
    return db.all(`SELECT ${SAFE} FROM users ORDER BY active DESC, name`);
  });

  router.post('/api/users', ({ user, body }) => {
    auth.requireRole(user, 'admin');
    required(body, ['name', 'email', 'password']);
    const email = str(body.email).toLowerCase();
    if (!isEmail(email)) throw badRequest('Enter a valid email', { email: 'Invalid email address' });
    if (str(body.password).length < 8) {
      throw badRequest('Password must be at least 8 characters', { password: 'Too short' });
    }
    if (db.get('SELECT id FROM users WHERE lower(email) = ?', [email])) {
      throw conflict('A user with that email already exists');
    }
    const role = oneOf(body.role, ROLES, 'staff');
    if (role === 'owner') auth.requireRole(user, 'owner');

    const { hash, salt } = auth.hashPassword(body.password);
    const { lastInsertRowid } = db.run(
      `INSERT INTO users (name, email, phone, password_hash, salt, role, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [str(body.name), email, str(body.phone), hash, salt, role, nowIso()],
    );
    auth.audit(user, 'create', 'users', lastInsertRowid, `${body.name} (${role})`);
    return db.get(`SELECT ${SAFE} FROM users WHERE id = ?`, [lastInsertRowid]);
  });

  router.put('/api/users/:id', ({ user, params, body }) => {
    auth.requireRole(user, 'admin');
    const target = db.get('SELECT * FROM users WHERE id = ?', [params.id]);
    if (!target) throw notFound('User not found');
    if (target.role === 'owner') auth.requireRole(user, 'owner');

    const role = body.role ? oneOf(body.role, ROLES, target.role) : target.role;
    if (role === 'owner') auth.requireRole(user, 'owner');

    const active = body.active === undefined ? target.active : bool(body.active);
    if (!active && Number(params.id) === user.id) {
      throw badRequest('You cannot deactivate your own account');
    }

    db.run(
      'UPDATE users SET name = ?, phone = ?, role = ?, active = ? WHERE id = ?',
      [str(body.name) || target.name, str(body.phone), role, active, params.id],
    );
    if (!active) db.run('DELETE FROM sessions WHERE user_id = ?', [params.id]);

    // Optional password reset by an admin.
    if (str(body.password)) {
      if (str(body.password).length < 8) throw badRequest('Password must be at least 8 characters');
      const { hash, salt } = auth.hashPassword(body.password);
      db.run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, params.id]);
      db.run('DELETE FROM sessions WHERE user_id = ?', [params.id]);
      auth.audit(user, 'update', 'users', params.id, 'password reset by admin');
    }

    auth.audit(user, 'update', 'users', params.id, target.name);
    return db.get(`SELECT ${SAFE} FROM users WHERE id = ?`, [params.id]);
  });

  router.del('/api/users/:id', ({ user, params }) => {
    auth.requireRole(user, 'owner');
    if (Number(params.id) === user.id) throw badRequest('You cannot delete your own account');
    const target = db.get('SELECT * FROM users WHERE id = ?', [params.id]);
    if (!target) throw notFound('User not found');
    const owners = db.scalar("SELECT COUNT(*) c FROM users WHERE role = 'owner' AND active = 1");
    if (target.role === 'owner' && owners <= 1) throw badRequest('The last owner account cannot be deleted');
    db.run('DELETE FROM users WHERE id = ?', [params.id]);
    auth.audit(user, 'delete', 'users', params.id, target.name);
    return { ok: true };
  });

  // -------------------------------------------------------- audit log
  router.get('/api/audit', ({ user, query }) => {
    auth.requireRole(user, 'admin');
    const where = [];
    const args = [];
    if (query.entity) { where.push('entity = ?'); args.push(query.entity); }
    if (query.action) { where.push('action = ?'); args.push(query.action); }
    if (query.q) {
      where.push('(user_name LIKE ? OR detail LIKE ?)');
      args.push(`%${query.q}%`, `%${query.q}%`);
    }
    const limit = Math.min(Number(query.limit) || 200, 1000);
    return db.all(
      `SELECT * FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ?`,
      [...args, limit],
    );
  });
};
