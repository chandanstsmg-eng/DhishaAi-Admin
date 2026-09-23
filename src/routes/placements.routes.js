'use strict';
/** Placement drives, interviews and offers — the tail of the lifecycle. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const C = require('../constants');
const {
  required, str, nowIso, today, toDate, notFound, oneOf, toCsv, money,
} = require('../util');
const { raw } = require('../router');

module.exports = function register(router) {
  router.get('/api/placements', ({ query }) => {
    const where = [];
    const args = [];
    if (query.status) { where.push('p.status = ?'); args.push(query.status); }
    if (query.student_id) { where.push('p.student_id = ?'); args.push(query.student_id); }
    if (query.company) { where.push('p.company LIKE ?'); args.push(`%${query.company}%`); }
    if (query.q) {
      where.push('(p.company LIKE ? OR p.role LIKE ? OR s.name LIKE ? OR s.reg_no LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like, like);
    }
    const rows = db.all(
      `SELECT p.*, s.name AS student_name, s.reg_no, s.phone,
              (SELECT c.name FROM enrollments e JOIN courses c ON c.id = e.course_id
                WHERE e.student_id = s.id ORDER BY e.id DESC LIMIT 1) AS course_name
         FROM placements p JOIN students s ON s.id = p.student_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(p.offer_date, p.interview_on, p.applied_on) DESC, p.id DESC`,
      args,
    );
    const joined = rows.filter((r) => r.status === 'Joined');
    const packages = joined.map((r) => r.package_lpa).filter((n) => n > 0);
    return {
      rows,
      stats: {
        total: rows.length,
        offered: rows.filter((r) => ['Offered', 'Joined'].includes(r.status)).length,
        joined: joined.length,
        avg_package: packages.length
          ? money(packages.reduce((a, b) => a + b, 0) / packages.length) : 0,
        highest_package: packages.length ? money(Math.max(...packages)) : 0,
      },
    };
  });

  router.get('/api/placements/export', () => {
    const rows = db.all(
      `SELECT s.reg_no, s.name AS student, p.company, p.role, p.package_lpa, p.location,
              p.applied_on, p.interview_on, p.offer_date, p.joined_on, p.status, p.remarks
         FROM placements p JOIN students s ON s.id = p.student_id
        ORDER BY p.id DESC`,
    );
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `dhishaai-placements-${today()}.csv`);
  });

  router.post('/api/placements', ({ user, body }) => {
    requireWrite(user, 'placements');
    required(body, ['student_id', 'company']);
    if (!db.get('SELECT id FROM students WHERE id = ?', [body.student_id])) {
      throw notFound('Student not found');
    }
    const status = oneOf(body.status, C.PLACEMENT_STATUS, 'Applied');
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO placements (student_id, company, role, package_lpa, location, applied_on,
                               interview_on, offer_date, joined_on, status, remarks, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        body.student_id, str(body.company), str(body.role), Number(body.package_lpa) || null,
        str(body.location), toDate(body.applied_on) || today(),
        toDate(body.interview_on) || null, toDate(body.offer_date) || null,
        toDate(body.joined_on) || null, status, str(body.remarks), nowIso(),
      ],
    );
    syncStudentStage(user, body.student_id, status);
    audit(user, 'create', 'placements', id, `${body.company} — ${status}`);
    return db.get('SELECT * FROM placements WHERE id = ?', [id]);
  });

  router.put('/api/placements/:id', ({ user, params, body }) => {
    requireWrite(user, 'placements');
    const p = db.get('SELECT * FROM placements WHERE id = ?', [params.id]);
    if (!p) throw notFound('Placement record not found');
    const status = oneOf(body.status, C.PLACEMENT_STATUS, p.status);
    db.run(
      `UPDATE placements SET company=?, role=?, package_lpa=?, location=?, applied_on=?,
              interview_on=?, offer_date=?, joined_on=?, status=?, remarks=? WHERE id=?`,
      [
        str(body.company) || p.company, str(body.role), Number(body.package_lpa) || null,
        str(body.location), toDate(body.applied_on) || p.applied_on,
        toDate(body.interview_on) || null,
        toDate(body.offer_date) || (status === 'Offered' ? today() : null),
        toDate(body.joined_on) || (status === 'Joined' ? today() : null),
        status, str(body.remarks), params.id,
      ],
    );
    syncStudentStage(user, p.student_id, status);
    audit(user, 'update', 'placements', params.id, `${p.company} — ${status}`);
    return db.get('SELECT * FROM placements WHERE id = ?', [params.id]);
  });

  router.del('/api/placements/:id', ({ user, params }) => {
    requireWrite(user, 'placements');
    const p = db.get('SELECT * FROM placements WHERE id = ?', [params.id]);
    if (!p) throw notFound('Placement record not found');
    db.run('DELETE FROM placements WHERE id = ?', [params.id]);
    audit(user, 'delete', 'placements', params.id, p.company);
    return { ok: true };
  });

  router.get('/api/placements/stats/summary', () => {
    const byStatus = db.all('SELECT status, COUNT(*) c FROM placements GROUP BY status');
    /*
     * One company, one row. Grouping on the raw column split "Infosys" from
     * "infosys" — three joiners showed up as a 2 and a 1, and the chart looked
     * like it had failed to update when it was faithfully reporting two
     * different names.
     *
     * The name shown is whichever spelling was typed most often, so the list
     * reads the way the office writes it rather than however the first record
     * happened to be entered. Ties fall to the plainer sort order, which puts
     * a capitalised spelling ahead of a lower-case one.
     */
    const byCompany = db.all(
      `SELECT (SELECT p2.company FROM placements p2
                WHERE LOWER(TRIM(p2.company)) = LOWER(TRIM(p.company))
                GROUP BY p2.company
                ORDER BY COUNT(*) DESC, p2.company
                LIMIT 1) AS company,
              COUNT(*) AS applications,
              SUM(CASE WHEN p.status = 'Joined' THEN 1 ELSE 0 END) AS joined,
              MAX(p.package_lpa) AS best_package
         FROM placements p
        GROUP BY LOWER(TRIM(p.company))
        ORDER BY joined DESC, applications DESC LIMIT 25`,
    );
    const eligible = db.scalar(
      "SELECT COUNT(*) c FROM students WHERE stage IN ('Placement Ready','Placed','Completed')",
    );
    const placed = db.scalar("SELECT COUNT(DISTINCT student_id) c FROM placements WHERE status = 'Joined'");
    return {
      by_status: byStatus,
      by_company: byCompany,
      eligible,
      placed,
      placement_rate: eligible ? Math.round((placed / eligible) * 100) : 0,
    };
  });
};

/** Offers/joins push the student along the lifecycle automatically. */
function syncStudentStage(user, studentId, status) {
  if (!['Offered', 'Joined'].includes(status)) return;
  const s = db.get('SELECT * FROM students WHERE id = ?', [studentId]);
  if (!s || s.stage === 'Placed' || s.stage === 'Dropped') return;
  db.run('UPDATE students SET stage = ?, updated_at = ? WHERE id = ?', ['Placed', nowIso(), studentId]);
  db.run(
    `INSERT INTO stage_history (student_id, from_stage, to_stage, note, changed_by, changed_at)
     VALUES (?,?,?,?,?,?)`,
    [studentId, s.stage, 'Placed', `Placement ${status.toLowerCase()}`, user.name, nowIso()],
  );
}
