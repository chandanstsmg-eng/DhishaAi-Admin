'use strict';
/** Trainers, counsellors and other staff records. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const {
  required, str, nowIso, notFound, badRequest, isEmail, bool, toCsv, toDate,
} = require('../util');
const { raw } = require('../router');

module.exports = function register(router) {
  router.get('/api/staff', ({ query }) => {
    const where = [];
    const args = [];
    // '1' active, '0' inactive, anything else (including blank) means both —
    // so the screen can offer "who has left" and not only "who is here".
    if (query.active === '1') where.push('s.active = 1');
    else if (query.active === '0') where.push('s.active = 0');
    if (query.designation) { where.push('s.designation = ?'); args.push(query.designation); }
    if (query.q) {
      where.push('(s.name LIKE ? OR s.email LIKE ? OR s.phone LIKE ? OR s.specialization LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like, like);
    }
    return db.all(
      `SELECT s.*,
              (SELECT COUNT(*) FROM batches b WHERE b.trainer_id = s.id)                       AS batch_count,
              (SELECT COUNT(*) FROM batches b WHERE b.trainer_id = s.id AND b.status='Ongoing') AS ongoing_batches
         FROM staff s
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.active DESC, s.name`,
      args,
    );
  });

  router.get('/api/staff/export', () => {
    const rows = db.all('SELECT name, email, phone, designation, specialization, join_date, active FROM staff ORDER BY name');
    return raw(toCsv(rows), 'text/csv; charset=utf-8', 'dhishaai-staff.csv');
  });

  router.get('/api/staff/:id', ({ params }) => {
    const s = db.get('SELECT * FROM staff WHERE id = ?', [params.id]);
    if (!s) throw notFound('Staff member not found');
    s.batches = db.all(
      `SELECT b.*, c.name AS course_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = b.id) AS students
         FROM batches b JOIN courses c ON c.id = b.course_id
        WHERE b.trainer_id = ? ORDER BY b.start_date DESC`,
      [params.id],
    );
    return s;
  });

  router.post('/api/staff', ({ user, body }) => {
    requireWrite(user, 'staff');
    required(body, ['name']);
    if (!isEmail(body.email)) throw badRequest('Enter a valid email', { email: 'Invalid email address' });
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO staff (name, email, phone, designation, specialization, join_date, active, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        str(body.name), str(body.email), str(body.phone), str(body.designation),
        str(body.specialization), toDate(body.join_date) || null,
        body.active === undefined ? 1 : bool(body.active), str(body.notes), nowIso(),
      ],
    );
    audit(user, 'create', 'staff', id, str(body.name));
    return db.get('SELECT * FROM staff WHERE id = ?', [id]);
  });

  router.put('/api/staff/:id', ({ user, params, body }) => {
    requireWrite(user, 'staff');
    const existing = db.get('SELECT * FROM staff WHERE id = ?', [params.id]);
    if (!existing) throw notFound('Staff member not found');
    if (!isEmail(body.email)) throw badRequest('Enter a valid email', { email: 'Invalid email address' });
    db.run(
      `UPDATE staff SET name=?, email=?, phone=?, designation=?, specialization=?,
              join_date=?, active=?, notes=? WHERE id=?`,
      [
        str(body.name) || existing.name, str(body.email), str(body.phone),
        str(body.designation), str(body.specialization), toDate(body.join_date) || null,
        body.active === undefined ? existing.active : bool(body.active), str(body.notes), params.id,
      ],
    );
    audit(user, 'update', 'staff', params.id, str(body.name) || existing.name);
    return db.get('SELECT * FROM staff WHERE id = ?', [params.id]);
  });

  router.del('/api/staff/:id', ({ user, params }) => {
    requireWrite(user, 'staff');
    const s = db.get('SELECT * FROM staff WHERE id = ?', [params.id]);
    if (!s) throw notFound('Staff member not found');
    const batches = db.scalar('SELECT COUNT(*) c FROM batches WHERE trainer_id = ?', [params.id]);
    if (batches) {
      throw badRequest(
        `${s.name} is the trainer on ${batches} batch(es). Reassign those batches, or mark this person inactive.`,
      );
    }
    db.run('DELETE FROM staff WHERE id = ?', [params.id]);
    audit(user, 'delete', 'staff', params.id, s.name);
    return { ok: true };
  });
};
