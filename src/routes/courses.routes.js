'use strict';
/** Course catalogue and its syllabus modules. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const settings = require('../settings');
const {
  required, str, money, nowIso, notFound, conflict, badRequest, oneOf, bool, toCsv,
} = require('../util');
const { raw } = require('../router');

const MODES = ['Offline', 'Online', 'Hybrid'];

function courseRow(id) {
  const c = db.get('SELECT * FROM courses WHERE id = ?', [id]);
  if (!c) throw notFound('Course not found');
  c.modules = db.all(
    'SELECT * FROM course_modules WHERE course_id = ? ORDER BY sequence, id', [id],
  );
  c.fee_plans = db.all(
    'SELECT * FROM fee_plans WHERE course_id = ? ORDER BY active DESC, name', [id],
  );
  c.stats = {
    batches: db.scalar('SELECT COUNT(*) c FROM batches WHERE course_id = ?', [id]),
    enrolled: db.scalar('SELECT COUNT(*) c FROM enrollments WHERE course_id = ?', [id]),
    active: db.scalar("SELECT COUNT(*) c FROM enrollments WHERE course_id = ? AND status = 'Active'", [id]),
    revenue: money(db.scalar(
      `SELECT COALESCE(SUM(p.amount),0) s FROM payments p
        JOIN enrollments e ON e.id = p.enrollment_id
       WHERE e.course_id = ? AND p.voided = 0`, [id])),
  };
  return c;
}

module.exports = function register(router) {
  router.get('/api/courses', ({ query }) => {
    const where = [];
    const args = [];
    // '1' active, '0' inactive, anything else (including blank) means both —
    // a retired course has to be findable, not just the ones still on sale.
    if (query.active === '1') where.push('c.active = 1');
    else if (query.active === '0') where.push('c.active = 0');
    if (query.category) { where.push('c.category = ?'); args.push(query.category); }
    if (query.q) {
      where.push('(c.name LIKE ? OR c.code LIKE ? OR c.category LIKE ?)');
      args.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
    }
    return db.all(
      `SELECT c.*,
              (SELECT COUNT(*) FROM batches b WHERE b.course_id = c.id)                        AS batch_count,
              (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id AND e.status='Active') AS active_students,
              (SELECT COUNT(*) FROM fee_plans f WHERE f.course_id = c.id AND f.active = 1)     AS plan_count
         FROM courses c
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.active DESC, c.name`,
      args,
    );
  });

  router.get('/api/courses/categories', () =>
    db.all("SELECT DISTINCT category FROM courses WHERE category IS NOT NULL AND category <> '' ORDER BY category")
      .map((r) => r.category));

  router.get('/api/courses/export', () => {
    const rows = db.all('SELECT code, name, category, mode, duration_weeks, total_hours, base_fee, tax_percent, active FROM courses ORDER BY name');
    return raw(toCsv(rows), 'text/csv; charset=utf-8', 'dhishaai-courses.csv');
  });

  router.get('/api/courses/:id', ({ params }) => courseRow(params.id));

  router.post('/api/courses', ({ user, body }) => {
    requireWrite(user, 'courses');
    required(body, ['code', 'name']);
    const code = str(body.code).toUpperCase();
    if (db.get('SELECT id FROM courses WHERE upper(code) = ?', [code])) {
      throw conflict(`Course code ${code} is already in use`);
    }
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO courses
         (code, name, category, mode, duration_weeks, total_hours, base_fee, tax_percent, description, active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        code, str(body.name), str(body.category), oneOf(body.mode, MODES),
        Number(body.duration_weeks) || 0, Number(body.total_hours) || 0,
        // a new course carries the institute GST rate unless one is given
        money(body.base_fee),
        money(body.tax_percent === undefined ? settings.get('default_tax_percent') : body.tax_percent),
        str(body.description), body.active === undefined ? 1 : bool(body.active), nowIso(),
      ],
    );
    audit(user, 'create', 'courses', id, `${code} — ${body.name}`);
    return courseRow(id);
  });

  router.put('/api/courses/:id', ({ user, params, body }) => {
    requireWrite(user, 'courses');
    const existing = db.get('SELECT * FROM courses WHERE id = ?', [params.id]);
    if (!existing) throw notFound('Course not found');
    const code = str(body.code || existing.code).toUpperCase();
    const clash = db.get('SELECT id FROM courses WHERE upper(code) = ? AND id <> ?', [code, params.id]);
    if (clash) throw conflict(`Course code ${code} is already in use`);

    db.run(
      `UPDATE courses SET code=?, name=?, category=?, mode=?, duration_weeks=?, total_hours=?,
              base_fee=?, tax_percent=?, description=?, active=? WHERE id=?`,
      [
        code, str(body.name) || existing.name, str(body.category), oneOf(body.mode, MODES, existing.mode),
        Number(body.duration_weeks) || 0, Number(body.total_hours) || 0,
        money(body.base_fee), money(body.tax_percent), str(body.description),
        body.active === undefined ? existing.active : bool(body.active), params.id,
      ],
    );
    audit(user, 'update', 'courses', params.id, code);
    return courseRow(params.id);
  });

  router.del('/api/courses/:id', ({ user, params }) => {
    requireWrite(user, 'courses');
    const used = db.scalar('SELECT COUNT(*) c FROM enrollments WHERE course_id = ?', [params.id]);
    if (used) {
      throw badRequest(
        `This course has ${used} enrollment(s) and cannot be deleted. Mark it inactive instead.`,
      );
    }
    const batches = db.scalar('SELECT COUNT(*) c FROM batches WHERE course_id = ?', [params.id]);
    if (batches) throw badRequest(`Delete or reassign the ${batches} batch(es) on this course first.`);
    const c = db.get('SELECT code FROM courses WHERE id = ?', [params.id]);
    if (!c) throw notFound('Course not found');
    db.run('DELETE FROM courses WHERE id = ?', [params.id]);
    audit(user, 'delete', 'courses', params.id, c.code);
    return { ok: true };
  });

  // -------------------------------------------------------- syllabus
  router.post('/api/courses/:id/modules', ({ user, params, body }) => {
    requireWrite(user, 'courses');
    required(body, ['title']);
    const next = db.scalar(
      'SELECT COALESCE(MAX(sequence),0)+1 n FROM course_modules WHERE course_id = ?', [params.id], 1,
    );
    db.run(
      'INSERT INTO course_modules (course_id, sequence, title, hours, outline) VALUES (?,?,?,?,?)',
      [params.id, Number(body.sequence) || next, str(body.title), Number(body.hours) || 0, str(body.outline)],
    );
    audit(user, 'create', 'course_modules', params.id, str(body.title));
    return courseRow(params.id);
  });

  router.put('/api/courses/:id/modules/:moduleId', ({ user, params, body }) => {
    requireWrite(user, 'courses');
    db.run(
      'UPDATE course_modules SET sequence=?, title=?, hours=?, outline=? WHERE id=? AND course_id=?',
      [Number(body.sequence) || 1, str(body.title), Number(body.hours) || 0, str(body.outline),
        params.moduleId, params.id],
    );
    return courseRow(params.id);
  });

  router.del('/api/courses/:id/modules/:moduleId', ({ user, params }) => {
    requireWrite(user, 'courses');
    db.run('DELETE FROM course_modules WHERE id = ? AND course_id = ?', [params.moduleId, params.id]);
    audit(user, 'delete', 'course_modules', params.moduleId, null);
    return courseRow(params.id);
  });
};
