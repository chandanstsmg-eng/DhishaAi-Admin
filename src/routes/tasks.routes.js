'use strict';
/** Lightweight to-do list, optionally linked to a student or enquiry. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const C = require('../constants');
const { required, str, nowIso, today, toDate, notFound, oneOf } = require('../util');

module.exports = function register(router) {
  router.get('/api/tasks', ({ query }) => {
    const where = [];
    const args = [];
    if (query.status) { where.push('t.status = ?'); args.push(query.status); }
    if (query.owner) { where.push('t.owner = ?'); args.push(query.owner); }
    if (query.overdue === '1') where.push("t.status = 'Open' AND t.due_date < date('now')");
    const rows = db.all(
      `SELECT t.*,
              CASE WHEN t.status = 'Open' AND t.due_date < date('now') THEN 1 ELSE 0 END AS overdue
         FROM tasks t
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.status ASC, overdue DESC,
                 CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
                 COALESCE(t.due_date,'9999') ASC
        LIMIT 300`,
      args,
    );
    return {
      rows,
      open: db.scalar("SELECT COUNT(*) c FROM tasks WHERE status = 'Open'"),
      overdue: db.scalar("SELECT COUNT(*) c FROM tasks WHERE status = 'Open' AND due_date < date('now')"),
    };
  });

  router.post('/api/tasks', ({ user, body }) => {
    requireWrite(user, 'tasks');
    required(body, ['title']);
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO tasks (title, detail, due_date, priority, status, owner, link_type, link_id, created_at)
       VALUES (?,?,?,?,'Open',?,?,?,?)`,
      [
        str(body.title), str(body.detail), toDate(body.due_date) || today(),
        oneOf(body.priority, C.PRIORITY, 'Medium'),
        str(body.owner) || user.name,
        str(body.link_type) || null, body.link_id || null, nowIso(),
      ],
    );
    audit(user, 'create', 'tasks', id, str(body.title));
    return db.get('SELECT * FROM tasks WHERE id = ?', [id]);
  });

  router.put('/api/tasks/:id', ({ user, params, body }) => {
    requireWrite(user, 'tasks');
    const t = db.get('SELECT * FROM tasks WHERE id = ?', [params.id]);
    if (!t) throw notFound('Task not found');
    const status = oneOf(body.status, ['Open', 'Done'], t.status);
    db.run(
      `UPDATE tasks SET title=?, detail=?, due_date=?, priority=?, status=?, owner=?, done_at=? WHERE id=?`,
      [
        str(body.title) || t.title, str(body.detail), toDate(body.due_date) || t.due_date,
        oneOf(body.priority, C.PRIORITY, t.priority), status, str(body.owner) || t.owner,
        status === 'Done' ? (t.done_at || nowIso()) : null, params.id,
      ],
    );
    return db.get('SELECT * FROM tasks WHERE id = ?', [params.id]);
  });

  router.del('/api/tasks/:id', ({ user, params }) => {
    requireWrite(user, 'tasks');
    db.run('DELETE FROM tasks WHERE id = ?', [params.id]);
    audit(user, 'delete', 'tasks', params.id, null);
    return { ok: true };
  });
};
