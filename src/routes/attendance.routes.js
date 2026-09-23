'use strict';
/** Session attendance marked per batch, per date. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const C = require('../constants');
const {
  required, str, nowIso, today, toDate, notFound, badRequest, oneOf, toCsv,
} = require('../util');
const { raw } = require('../router');

module.exports = function register(router) {
  /** Roster for one batch on one date, pre-filled with any existing marks. */
  router.get('/api/attendance/sheet', ({ query }) => {
    required(query, ['batch_id']);
    const date = toDate(query.date) || today();
    const batch = db.get(
      `SELECT b.*, c.name AS course_name, s.name AS trainer_name
         FROM batches b JOIN courses c ON c.id = b.course_id
         LEFT JOIN staff s ON s.id = b.trainer_id WHERE b.id = ?`, [query.batch_id],
    );
    if (!batch) throw notFound('Batch not found');

    const roster = db.all(
      `SELECT st.id AS student_id, st.reg_no, st.name, st.phone, e.status AS enrollment_status,
              a.id AS attendance_id, a.status, a.remark
         FROM enrollments e
         JOIN students st ON st.id = e.student_id
         LEFT JOIN attendance a ON a.student_id = st.id AND a.batch_id = e.batch_id AND a.session_date = ?
        WHERE e.batch_id = ? AND e.status IN ('Active','On Hold')
        ORDER BY st.name`,
      [date, query.batch_id],
    );
    return {
      batch,
      date,
      roster,
      marked: roster.filter((r) => r.attendance_id).length,
      statuses: C.ATTENDANCE_STATUS,
    };
  });

  /** Upsert the whole sheet in one transaction. */
  router.post('/api/attendance/sheet', ({ user, body }) => {
    requireWrite(user, 'attendance');
    required(body, ['batch_id']);
    const date = toDate(body.session_date) || today();
    if (!Array.isArray(body.records) || !body.records.length) {
      throw badRequest('Send at least one attendance record');
    }
    const batch = db.get('SELECT * FROM batches WHERE id = ?', [body.batch_id]);
    if (!batch) throw notFound('Batch not found');
    if (date > today()) throw badRequest('Attendance cannot be marked for a future date');

    return db.tx(() => {
      let saved = 0;
      for (const r of body.records) {
        if (!r.student_id) continue;
        db.run(
          `INSERT INTO attendance (batch_id, student_id, session_date, status, remark, marked_by, marked_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(batch_id, student_id, session_date)
           DO UPDATE SET status = excluded.status, remark = excluded.remark,
                         marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
          [
            body.batch_id, r.student_id, date,
            oneOf(r.status, C.ATTENDANCE_STATUS, 'Present'),
            str(r.remark), user.name, nowIso(),
          ],
        );
        saved++;
      }
      audit(user, 'update', 'attendance', body.batch_id, `${batch.code} ${date}: ${saved} marked`);
      return { ok: true, saved, date };
    });
  });

  /** Per-student percentage for a batch, plus the list of session dates held. */
  router.get('/api/attendance/summary', ({ query }) => {
    required(query, ['batch_id']);
    const rows = db.all(
      `SELECT st.id AS student_id, st.reg_no, st.name,
              COUNT(a.id)                                                    AS sessions,
              -- the classes that count: held, and this student was due at them
              SUM(CASE WHEN a.status ${C.COUNTED_SQL} THEN 1 ELSE 0 END)      AS held,
              SUM(CASE WHEN a.status ${C.ATTENDED_SQL} THEN 1 ELSE 0 END)     AS present,
              SUM(CASE WHEN a.status = 'Absent'  THEN 1 ELSE 0 END)           AS absent,
              SUM(CASE WHEN a.status = 'Excused' THEN 1 ELSE 0 END)           AS excused,
              SUM(CASE WHEN a.status = ?         THEN 1 ELSE 0 END)           AS no_class
         FROM enrollments e
         JOIN students st ON st.id = e.student_id
         LEFT JOIN attendance a ON a.student_id = st.id AND a.batch_id = e.batch_id
        WHERE e.batch_id = ?
        GROUP BY st.id ORDER BY st.name`,
      [C.NO_CLASS, query.batch_id],
    );
    for (const r of rows) {
      /*
       * present + absent, and nothing else. A cancelled session never ran and
       * an excused one was allowed, so neither is in the total — which also
       * means the row adds up: held is exactly the two columns beside it.
       * `counted` is kept as an alias so an older browser tab still reads the
       * same denominator it always did.
       */
      r.counted = r.held;
      r.percent = r.held ? Math.round((r.present / r.held) * 100) : null;
    }
    const dates = db.all(
      'SELECT DISTINCT session_date FROM attendance WHERE batch_id = ? ORDER BY session_date DESC',
      [query.batch_id],
    ).map((d) => d.session_date);
    /*
     * Sessions the whole batch sat out — the ones worth saying out loud, since
     * they are the reason the session count and the per-student totals differ.
     */
    const cancelled = db.scalar(
      `SELECT COUNT(*) c FROM (
         SELECT session_date FROM attendance WHERE batch_id = ?
          GROUP BY session_date
         HAVING SUM(CASE WHEN status <> ? THEN 1 ELSE 0 END) = 0)`,
      [query.batch_id, C.NO_CLASS],
    );
    const excused = db.scalar(
      "SELECT COUNT(*) c FROM attendance WHERE batch_id = ? AND status = 'Excused'",
      [query.batch_id],
    );
    return { rows, dates, sessions_held: dates.length, cancelled_sessions: cancelled, excused };
  });

  router.get('/api/attendance/export', ({ query }) => {
    required(query, ['batch_id']);
    const rows = db.all(
      `SELECT a.session_date, st.reg_no, st.name, a.status, a.remark, a.marked_by
         FROM attendance a JOIN students st ON st.id = a.student_id
        WHERE a.batch_id = ? ORDER BY a.session_date DESC, st.name`,
      [query.batch_id],
    );
    const b = db.get('SELECT code FROM batches WHERE id = ?', [query.batch_id]);
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `attendance-${b ? b.code : query.batch_id}.csv`);
  });

  /** One student's full attendance history. */
  router.get('/api/attendance/student/:id', ({ params }) =>
    db.all(
      `SELECT a.*, b.code AS batch_code, c.name AS course_name
         FROM attendance a
         JOIN batches b ON b.id = a.batch_id
         JOIN courses c ON c.id = b.course_id
        WHERE a.student_id = ? ORDER BY a.session_date DESC LIMIT 400`,
      [params.id],
    ));

  router.del('/api/attendance/:id', ({ user, params }) => {
    requireWrite(user, 'attendance');
    db.run('DELETE FROM attendance WHERE id = ?', [params.id]);
    audit(user, 'delete', 'attendance', params.id, null);
    return { ok: true };
  });
};
