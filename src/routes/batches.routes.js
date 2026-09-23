'use strict';
/** Batches: scheduling, roster and derived session calendar. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const {
  required, str, nowIso, notFound, conflict, badRequest, oneOf, toDate, today, toCsv,
} = require('../util');
const { raw } = require('../router');

const STATUS = ['Planned', 'Ongoing', 'Completed', 'Cancelled'];
const MODES = ['Offline', 'Online', 'Hybrid'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Expand "Mon,Wed,Fri" across start..end into concrete session dates. */
function sessionDates(batch, cap = 200) {
  if (!batch.start_date) return [];
  const wanted = str(batch.days).split(',').map((d) => d.trim().slice(0, 3)).filter(Boolean);
  const end = new Date(batch.end_date || batch.start_date);
  const out = [];
  const cursor = new Date(batch.start_date);
  while (cursor <= end && out.length < cap) {
    if (!wanted.length || wanted.includes(DOW[cursor.getDay()])) out.push(toDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function batchRow(id) {
  const b = db.get(
    `SELECT b.*, c.name AS course_name, c.code AS course_code, s.name AS trainer_name
       FROM batches b
       JOIN courses c ON c.id = b.course_id
       LEFT JOIN staff s ON s.id = b.trainer_id
      WHERE b.id = ?`, [id],
  );
  if (!b) throw notFound('Batch not found');
  b.roster = db.all(
    `SELECT e.id AS enrollment_id, e.status AS enrollment_status, e.net_fee,
            st.id AS student_id, st.reg_no, st.name, st.phone, st.email, st.stage,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.enrollment_id = e.id AND p.voided = 0), 0) AS paid
       FROM enrollments e JOIN students st ON st.id = e.student_id
      WHERE e.batch_id = ? ORDER BY st.name`, [id],
  );
  b.sessions = sessionDates(b);
  b.filled = b.roster.length;
  b.seats_left = Math.max(0, (b.capacity || 0) - b.filled);
  return b;
}

module.exports = function register(router) {
  router.get('/api/batches', ({ query }) => {
    const where = [];
    const args = [];
    if (query.status) { where.push('b.status = ?'); args.push(query.status); }
    if (query.course_id) { where.push('b.course_id = ?'); args.push(query.course_id); }
    if (query.trainer_id) { where.push('b.trainer_id = ?'); args.push(query.trainer_id); }
    if (query.q) {
      where.push('(b.code LIKE ? OR c.name LIKE ? OR b.room LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like);
    }
    return db.all(
      `SELECT b.*, c.name AS course_name, c.code AS course_code, s.name AS trainer_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = b.id) AS filled
         FROM batches b
         JOIN courses c ON c.id = b.course_id
         LEFT JOIN staff s ON s.id = b.trainer_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY CASE b.status WHEN 'Ongoing' THEN 0 WHEN 'Planned' THEN 1 ELSE 2 END,
                 b.start_date DESC`,
      args,
    );
  });

  router.get('/api/batches/export', () => {
    const rows = db.all(
      `SELECT b.code, c.name AS course, s.name AS trainer, b.mode, b.start_date, b.end_date,
              b.days, b.time_slot, b.room, b.capacity, b.status,
              (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = b.id) AS enrolled
         FROM batches b JOIN courses c ON c.id = b.course_id
         LEFT JOIN staff s ON s.id = b.trainer_id ORDER BY b.start_date DESC`,
    );
    return raw(toCsv(rows), 'text/csv; charset=utf-8', 'dhishaai-batches.csv');
  });

  router.get('/api/batches/:id', ({ params }) => batchRow(params.id));

  router.post('/api/batches', ({ user, body }) => {
    requireWrite(user, 'batches');
    required(body, ['code', 'course_id']);
    /*
     * Kept exactly as typed — the code is the institute's own numbering and
     * may be any shape at all. Only the clash check ignores case, so "da-101"
     * and "DA-101" cannot both exist and be told apart by eye.
     */
    const code = str(body.code);
    if (db.get('SELECT id FROM batches WHERE upper(code) = upper(?)', [code])) {
      throw conflict(`Batch code ${code} is already in use`);
    }
    if (!db.get('SELECT id FROM courses WHERE id = ?', [body.course_id])) {
      throw badRequest('Pick a valid course', { course_id: 'Required' });
    }
    if (body.start_date && body.end_date && toDate(body.end_date) < toDate(body.start_date)) {
      throw badRequest('End date cannot be before the start date', { end_date: 'Before start date' });
    }
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO batches (code, course_id, trainer_id, mode, start_date, end_date, days,
                            time_slot, room, capacity, status, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        code, body.course_id, body.trainer_id || null, oneOf(body.mode, MODES),
        toDate(body.start_date) || null, toDate(body.end_date) || null,
        str(body.days), str(body.time_slot), str(body.room),
        Number(body.capacity) || 30, oneOf(body.status, STATUS), str(body.notes), nowIso(),
      ],
    );
    audit(user, 'create', 'batches', id, code);
    return batchRow(id);
  });

  router.put('/api/batches/:id', ({ user, params, body }) => {
    requireWrite(user, 'batches');
    const existing = db.get('SELECT * FROM batches WHERE id = ?', [params.id]);
    if (!existing) throw notFound('Batch not found');
    const code = str(body.code || existing.code);
    if (db.get('SELECT id FROM batches WHERE upper(code) = upper(?) AND id <> ?', [code, params.id])) {
      throw conflict(`Batch code ${code} is already in use`);
    }
    const start = toDate(body.start_date) || existing.start_date;
    const end = toDate(body.end_date) || existing.end_date;
    if (start && end && end < start) {
      throw badRequest('End date cannot be before the start date', { end_date: 'Before start date' });
    }
    const capacity = Number(body.capacity) || existing.capacity;
    const filled = db.scalar('SELECT COUNT(*) c FROM enrollments WHERE batch_id = ?', [params.id]);
    if (capacity < filled) {
      throw badRequest(`Capacity cannot be below the ${filled} students already enrolled`);
    }

    db.run(
      `UPDATE batches SET code=?, course_id=?, trainer_id=?, mode=?, start_date=?, end_date=?,
              days=?, time_slot=?, room=?, capacity=?, status=?, notes=? WHERE id=?`,
      [
        code, body.course_id || existing.course_id, body.trainer_id || null,
        oneOf(body.mode, MODES, existing.mode), start, end,
        str(body.days), str(body.time_slot), str(body.room), capacity,
        oneOf(body.status, STATUS, existing.status), str(body.notes), params.id,
      ],
    );
    audit(user, 'update', 'batches', params.id, code);
    return batchRow(params.id);
  });

  router.del('/api/batches/:id', ({ user, params }) => {
    requireWrite(user, 'batches');
    const b = db.get('SELECT * FROM batches WHERE id = ?', [params.id]);
    if (!b) throw notFound('Batch not found');
    const filled = db.scalar('SELECT COUNT(*) c FROM enrollments WHERE batch_id = ?', [params.id]);
    if (filled) throw badRequest(`${filled} student(s) are in this batch. Move them out, or cancel the batch instead.`);
    db.run('DELETE FROM batches WHERE id = ?', [params.id]);
    audit(user, 'delete', 'batches', params.id, b.code);
    return { ok: true };
  });

  /** Batches running today — used by the attendance screen. */
  router.get('/api/batches/today/list', () => {
    const d = today();
    const dow = DOW[new Date(d).getDay()];
    return db.all(
      `SELECT b.*, c.name AS course_name, s.name AS trainer_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = b.id) AS filled
         FROM batches b JOIN courses c ON c.id = b.course_id
         LEFT JOIN staff s ON s.id = b.trainer_id
        WHERE b.status = 'Ongoing'
          AND (b.start_date IS NULL OR b.start_date <= ?)
          AND (b.end_date IS NULL OR b.end_date >= ?)
          AND (b.days IS NULL OR b.days = '' OR b.days LIKE ?)
        ORDER BY b.time_slot`,
      [d, d, `%${dow}%`],
    );
  });
};
