'use strict';
/** Students: profile, documents, lifecycle stage, and the 360° detail view. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const settings = require('../settings');
const C = require('../constants');
const {
  required, str, money, nowIso, today, toDate, notFound, badRequest, conflict,
  isEmail, isPhone, oneOf, toCsv, clamp,
} = require('../util');
const { raw } = require('../router');

/** Money roll-up for one student across every enrollment. */
const FEE_SUMMARY = `
  COALESCE((SELECT SUM(e.net_fee) FROM enrollments e
             WHERE e.student_id = s.id AND e.status <> 'Dropped'), 0) AS total_fee,
  COALESCE((SELECT SUM(p.amount) FROM payments p
             WHERE p.student_id = s.id AND p.voided = 0), 0)          AS total_paid,
  COALESCE((SELECT SUM(i.amount - i.paid_amount) FROM installments i
             JOIN enrollments e2 ON e2.id = i.enrollment_id
            WHERE e2.student_id = s.id AND i.status IN ('Pending','Partial')
              AND i.due_date < date('now')), 0)                       AS overdue_amount
`;

function detail(id) {
  const s = db.get(`SELECT s.*, ${FEE_SUMMARY} FROM students s WHERE s.id = ?`, [id]);
  if (!s) throw notFound('Student not found');
  s.balance = money(s.total_fee - s.total_paid);

  s.enrollments = db.all(
    `SELECT e.*, c.name AS course_name, c.code AS course_code,
            b.code AS batch_code, b.start_date AS batch_start, b.time_slot,
            st.name AS trainer_name,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.enrollment_id = e.id AND p.voided = 0), 0) AS paid
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN batches b ON b.id = e.batch_id
       LEFT JOIN staff st ON st.id = b.trainer_id
      WHERE e.student_id = ? ORDER BY e.enrolled_on DESC`, [id],
  );
  for (const e of s.enrollments) {
    e.balance = money(e.net_fee - e.paid);
    e.installments = db.all(
      'SELECT * FROM installments WHERE enrollment_id = ? ORDER BY sequence, id', [e.id],
    );
  }

  s.payments = db.all(
    `SELECT p.*, c.name AS course_name
       FROM payments p
       JOIN enrollments e ON e.id = p.enrollment_id
       JOIN courses c ON c.id = e.course_id
      WHERE p.student_id = ? ORDER BY p.paid_on DESC, p.id DESC`, [id],
  );
  s.documents = db.all(
    'SELECT * FROM student_documents WHERE student_id = ? ORDER BY uploaded_at DESC', [id],
  );
  s.stage_history = db.all(
    'SELECT * FROM stage_history WHERE student_id = ? ORDER BY changed_at DESC', [id],
  );
  s.placements = db.all(
    'SELECT * FROM placements WHERE student_id = ? ORDER BY COALESCE(offer_date, applied_on) DESC', [id],
  );
  // present + absent, the same rule the batch summary uses — see COUNTED_SQL
  s.attendance = db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status ${C.ATTENDED_SQL} THEN 1 ELSE 0 END) AS present
       FROM attendance WHERE student_id = ? AND status ${C.COUNTED_SQL}`, [id],
  ) || { total: 0, present: 0 };
  s.attendance.percent = s.attendance.total
    ? Math.round((s.attendance.present / s.attendance.total) * 100) : null;
  return s;
}

function validate(body) {
  if (!isEmail(body.email)) throw badRequest('Enter a valid email', { email: 'Invalid email address' });
  if (!isPhone(body.phone)) throw badRequest('Enter a valid phone number', { phone: 'Invalid phone number' });
}

const WRITABLE = [
  'name', 'email', 'phone', 'alt_phone', 'dob', 'gender', 'address', 'city', 'state',
  'pincode', 'qualification', 'college', 'passout_year', 'experience',
  'guardian_name', 'guardian_phone', 'source', 'notes',
];

module.exports = function register(router) {
  // -------------------------------------------------------------- list
  router.get('/api/students', ({ query }) => {
    const where = [];
    const args = [];
    if (query.status) { where.push('s.status = ?'); args.push(query.status); }
    if (query.stage) { where.push('s.stage = ?'); args.push(query.stage); }
    if (query.source) { where.push('s.source = ?'); args.push(query.source); }
    if (query.course_id) {
      where.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.course_id = ?)');
      args.push(query.course_id);
    }
    if (query.batch_id) {
      where.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.batch_id = ?)');
      args.push(query.batch_id);
    }
    if (query.q) {
      where.push('(s.name LIKE ? OR s.reg_no LIKE ? OR s.phone LIKE ? OR s.email LIKE ? OR s.college LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like, like, like);
    }
    /*
     * Joined-date range. Both ends are inclusive, hence date() on either side —
     * a bare string compare would drop the "to" day itself. Students with no
     * joining date recorded fall outside any range.
     */
    if (query.from) { where.push('date(s.joined_on) >= date(?)'); args.push(query.from); }
    if (query.to) { where.push('date(s.joined_on) <= date(?)'); args.push(query.to); }
    if (query.from || query.to) where.push('s.joined_on IS NOT NULL');
    if (query.dues === '1') {
      where.push(`(SELECT COALESCE(SUM(e.net_fee),0) FROM enrollments e
                    WHERE e.student_id = s.id AND e.status <> 'Dropped')
                  > (SELECT COALESCE(SUM(p.amount),0) FROM payments p
                      WHERE p.student_id = s.id AND p.voided = 0)`);
    }

    const sortable = {
      name: 's.name', reg_no: 's.reg_no', created_at: 's.created_at DESC',
      balance: '(total_fee - total_paid) DESC', stage: 's.stage',
    };
    const order = sortable[query.sort] || 's.created_at DESC';
    const limit = clamp(query.limit || 100, 1, 1000);
    const offset = clamp(query.offset || 0, 0, 1e6);

    const rows = db.all(
      `SELECT s.id, s.reg_no, s.name, s.email, s.phone, s.city, s.status, s.stage,
              s.source, s.joined_on, s.created_at, ${FEE_SUMMARY},
              (SELECT group_concat(c.name, ', ') FROM enrollments e
                 JOIN courses c ON c.id = e.course_id
                WHERE e.student_id = s.id)                    AS courses,
              (SELECT b.code FROM enrollments e
                 JOIN batches b ON b.id = e.batch_id
                WHERE e.student_id = s.id ORDER BY e.id DESC LIMIT 1) AS batch_code,
              (SELECT b.start_date FROM enrollments e
                 JOIN batches b ON b.id = e.batch_id
                WHERE e.student_id = s.id ORDER BY e.id DESC LIMIT 1) AS batch_start
         FROM students s
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    for (const r of rows) r.balance = money(r.total_fee - r.total_paid);

    const total = db.scalar(
      `SELECT COUNT(*) c FROM students s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, args,
    );
    return { rows, total, limit, offset };
  });

  // ------------------------------------------------------- kanban board
  router.get('/api/students/pipeline', () => {
    const rows = db.all(
      `SELECT s.id, s.reg_no, s.name, s.phone, s.stage, s.status, s.joined_on, ${FEE_SUMMARY},
              (SELECT c.name FROM enrollments e JOIN courses c ON c.id = e.course_id
                WHERE e.student_id = s.id ORDER BY e.id DESC LIMIT 1) AS course_name,
              (SELECT b.code FROM enrollments e JOIN batches b ON b.id = e.batch_id
                WHERE e.student_id = s.id ORDER BY e.id DESC LIMIT 1) AS batch_code,
              (SELECT b.start_date FROM enrollments e JOIN batches b ON b.id = e.batch_id
                WHERE e.student_id = s.id ORDER BY e.id DESC LIMIT 1) AS batch_start
         FROM students s ORDER BY s.updated_at DESC, s.id DESC`,
    );
    const columns = C.STUDENT_STAGES.map((stage) => ({ stage, cards: [] }));
    const index = Object.fromEntries(columns.map((c, i) => [c.stage, i]));
    for (const r of rows) {
      r.balance = money(r.total_fee - r.total_paid);
      /*
       * A stage no longer on the list lands in the first column rather than
       * nowhere. Boot moves anyone standing on a retired stage, so this should
       * never fire — but a restored backup or a hand-edited row must not make a
       * student vanish from the one screen meant to show where everyone is.
       */
      const i = index[r.stage] !== undefined ? index[r.stage] : 0;
      columns[i].cards.push(r);
    }
    return { columns, stages: C.STUDENT_STAGES };
  });

  router.get('/api/students/export', ({ query }) => {
    // the download honours the status, source and joined-date filters on
    // screen, so what lands in the CSV matches what was being looked at
    const where = [];
    const args = [];
    if (query.status) { where.push('s.status = ?'); args.push(query.status); }
    if (query.source) { where.push('s.source = ?'); args.push(query.source); }
    if (query.from) { where.push('date(s.joined_on) >= date(?)'); args.push(query.from); }
    if (query.to) { where.push('date(s.joined_on) <= date(?)'); args.push(query.to); }
    if (query.from || query.to) where.push('s.joined_on IS NOT NULL');
    const rows = db.all(
      `SELECT s.reg_no, s.name, s.phone, s.email, s.city, s.qualification, s.college,
              s.source, s.status, s.stage, s.joined_on, ${FEE_SUMMARY},
              (SELECT group_concat(c.name, ' | ') FROM enrollments e
                 JOIN courses c ON c.id = e.course_id WHERE e.student_id = s.id) AS courses
         FROM students s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.reg_no`, args,
    );
    for (const r of rows) { r.balance = money(r.total_fee - r.total_paid); delete r.overdue_amount; }
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `dhishaai-students-${today()}.csv`);
  });

  router.get('/api/students/:id', ({ params }) => detail(params.id));

  // ------------------------------------------------------------ create
  router.post('/api/students', ({ user, body }) => {
    requireWrite(user, 'students');
    required(body, ['name', 'phone']);
    validate(body);

    const phone = str(body.phone);
    const dupe = db.get('SELECT id, reg_no, name FROM students WHERE phone = ?', [phone]);
    if (dupe && !body.allow_duplicate_phone) {
      throw conflict(
        `${dupe.name} (${dupe.reg_no}) is already registered with ${phone}. ` +
        'Resend with allow_duplicate_phone to add anyway.',
      );
    }

    return db.tx(() => {
      const regNo = str(body.reg_no) || settings.nextRegNo();
      if (db.get('SELECT id FROM students WHERE reg_no = ?', [regNo])) {
        throw conflict(`Registration number ${regNo} already exists`);
      }
      const stage = oneOf(body.stage, C.STUDENT_STAGES, C.FIRST_STAGE);
      const cols = {
        reg_no: regNo,
        status: oneOf(body.status, C.STUDENT_STATUS, 'Active'),
        stage,
        joined_on: toDate(body.joined_on) || today(),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      for (const k of WRITABLE) cols[k] = k === 'dob' ? (toDate(body.dob) || null) : str(body[k]);

      const keys = Object.keys(cols);
      const { lastInsertRowid: id } = db.run(
        `INSERT INTO students (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        keys.map((k) => cols[k]),
      );
      db.run(
        `INSERT INTO stage_history (student_id, from_stage, to_stage, note, changed_by, changed_at)
         VALUES (?,?,?,?,?,?)`,
        [id, null, stage, 'Student registered', user.name, nowIso()],
      );
      audit(user, 'create', 'students', id, `${regNo} — ${body.name}`);
      return detail(id);
    });
  });

  // ------------------------------------------------------------ update
  router.put('/api/students/:id', ({ user, params, body }) => {
    requireWrite(user, 'students');
    const existing = db.get('SELECT * FROM students WHERE id = ?', [params.id]);
    if (!existing) throw notFound('Student not found');
    validate(body);

    const cols = {
      status: oneOf(body.status, C.STUDENT_STATUS, existing.status),
      joined_on: toDate(body.joined_on) || existing.joined_on,
      updated_at: nowIso(),
    };
    for (const k of WRITABLE) {
      if (body[k] !== undefined) cols[k] = k === 'dob' ? (toDate(body.dob) || null) : str(body[k]);
    }
    if (!cols.name && body.name !== undefined) cols.name = existing.name;

    const keys = Object.keys(cols);
    db.run(
      `UPDATE students SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map((k) => cols[k]), params.id],
    );

    // Status changes cascade to that student's active enrollments.
    if (cols.status !== existing.status && ['Dropped', 'Completed'].includes(cols.status)) {
      db.run(
        "UPDATE enrollments SET status = ? WHERE student_id = ? AND status = 'Active'",
        [cols.status, params.id],
      );
    }
    audit(user, 'update', 'students', params.id, existing.reg_no);
    return detail(params.id);
  });

  // ------------------------------------------------------------- stage
  router.post('/api/students/:id/stage', ({ user, params, body }) => {
    requireWrite(user, 'students');
    required(body, ['stage']);
    const s = db.get('SELECT * FROM students WHERE id = ?', [params.id]);
    if (!s) throw notFound('Student not found');
    const stage = oneOf(body.stage, C.STUDENT_STAGES, null);
    if (!stage) throw badRequest(`Unknown stage. Use one of: ${C.STUDENT_STAGES.join(', ')}`);
    if (stage === s.stage) return detail(params.id);

    return db.tx(() => {
      db.run('UPDATE students SET stage = ?, updated_at = ? WHERE id = ?', [stage, nowIso(), params.id]);
      db.run(
        `INSERT INTO stage_history (student_id, from_stage, to_stage, note, changed_by, changed_at)
         VALUES (?,?,?,?,?,?)`,
        [params.id, s.stage, stage, str(body.note), user.name, nowIso()],
      );
      // Terminal stages keep the headline status honest.
      if (stage === 'Completed') db.run("UPDATE students SET status = 'Completed' WHERE id = ?", [params.id]);
      if (stage === 'Dropped') db.run("UPDATE students SET status = 'Dropped' WHERE id = ?", [params.id]);
      audit(user, 'stage', 'students', params.id, `${s.stage} → ${stage}`);
      return detail(params.id);
    });
  });

  // --------------------------------------------------------- documents
  router.post('/api/students/:id/documents', ({ user, params, body }) => {
    requireWrite(user, 'students');
    required(body, ['doc_type']);
    if (!db.get('SELECT id FROM students WHERE id = ?', [params.id])) throw notFound('Student not found');
    db.run(
      `INSERT INTO student_documents (student_id, doc_type, doc_no, file_name, verified, remarks, uploaded_at)
       VALUES (?,?,?,?,?,?,?)`,
      [params.id, str(body.doc_type), str(body.doc_no), str(body.file_name),
        body.verified ? 1 : 0, str(body.remarks), nowIso()],
    );
    audit(user, 'create', 'student_documents', params.id, str(body.doc_type));
    return detail(params.id);
  });

  router.put('/api/students/:id/documents/:docId', ({ user, params, body }) => {
    requireWrite(user, 'students');
    db.run(
      'UPDATE student_documents SET doc_type=?, doc_no=?, file_name=?, verified=?, remarks=? WHERE id=? AND student_id=?',
      [str(body.doc_type), str(body.doc_no), str(body.file_name),
        body.verified ? 1 : 0, str(body.remarks), params.docId, params.id],
    );
    return detail(params.id);
  });

  router.del('/api/students/:id/documents/:docId', ({ user, params }) => {
    requireWrite(user, 'students');
    db.run('DELETE FROM student_documents WHERE id = ? AND student_id = ?', [params.docId, params.id]);
    audit(user, 'delete', 'student_documents', params.docId, null);
    return detail(params.id);
  });

  // ------------------------------------------------------------ delete
  router.del('/api/students/:id', ({ user, params, body }) => {
    requireWrite(user, 'students');
    const s = db.get('SELECT * FROM students WHERE id = ?', [params.id]);
    if (!s) throw notFound('Student not found');
    const paid = db.scalar(
      'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE student_id = ? AND voided = 0', [params.id],
    );
    if (paid > 0 && !body.force) {
      throw badRequest(
        `${s.name} has ₹${money(paid).toLocaleString('en-IN')} of recorded payments. ` +
        'Deleting removes that money from every report. Mark the student as Dropped instead, ' +
        'or resend with force to confirm.',
      );
    }
    db.run('DELETE FROM students WHERE id = ?', [params.id]);
    audit(user, 'delete', 'students', params.id, `${s.reg_no} — ${s.name}`);
    return { ok: true };
  });
};
