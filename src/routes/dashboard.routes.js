'use strict';
/** The landing screen: KPI tiles, trend series, action queues and alerts. */

const { db } = require('../db');
const settings = require('../settings');
const { money, today, lastNMonths, monthStart } = require('../util');

module.exports = function register(router) {
  router.get('/api/dashboard', () => {
    const d = today();
    const mStart = monthStart(d);
    const reminderDays = Number(settings.get('fee_due_reminder_days')) || 7;

    // ------------------------------------------------------------ KPIs
    const kpis = {
      students_total: db.scalar('SELECT COUNT(*) c FROM students'),
      students_active: db.scalar("SELECT COUNT(*) c FROM students WHERE status = 'Active'"),
      students_new_month: db.scalar('SELECT COUNT(*) c FROM students WHERE joined_on >= ?', [mStart]),
      batches_ongoing: db.scalar("SELECT COUNT(*) c FROM batches WHERE status = 'Ongoing'"),
      courses_active: db.scalar('SELECT COUNT(*) c FROM courses WHERE active = 1'),

      collected_today: money(db.scalar(
        'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE paid_on = ? AND voided = 0', [d])),
      collected_month: money(db.scalar(
        'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE paid_on >= ? AND voided = 0', [mStart])),
      collected_total: money(db.scalar(
        'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE voided = 0')),
      expenses_month: money(db.scalar(
        'SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE spent_on >= ?', [mStart])),

      billed_total: money(db.scalar(
        "SELECT COALESCE(SUM(net_fee),0) s FROM enrollments WHERE status <> 'Dropped'")),
      overdue_amount: money(db.scalar(
        `SELECT COALESCE(SUM(i.amount - i.paid_amount),0) s FROM installments i
           JOIN enrollments e ON e.id = i.enrollment_id
          WHERE i.status IN ('Pending','Partial') AND i.due_date < date('now') AND e.status <> 'Dropped'`)),
      overdue_count: db.scalar(
        `SELECT COUNT(DISTINCT e.student_id) c FROM installments i
           JOIN enrollments e ON e.id = i.enrollment_id
          WHERE i.status IN ('Pending','Partial') AND i.due_date < date('now') AND e.status <> 'Dropped'`),

      enquiries_open: db.scalar("SELECT COUNT(*) c FROM enquiries WHERE status NOT IN ('Converted','Lost')"),
      enquiries_due: db.scalar(
        `SELECT COUNT(*) c FROM enquiries
          WHERE next_followup <= date('now') AND status NOT IN ('Converted','Lost')`),
      placements_joined: db.scalar("SELECT COUNT(*) c FROM placements WHERE status = 'Joined'"),
      tasks_open: db.scalar("SELECT COUNT(*) c FROM tasks WHERE status = 'Open'"),
    };
    kpis.outstanding_total = money(kpis.billed_total - kpis.collected_total);
    kpis.net_month = money(kpis.collected_month - kpis.expenses_month);
    kpis.collection_rate = kpis.billed_total
      ? Math.round((kpis.collected_total / kpis.billed_total) * 100) : 0;

    // ---------------------------------------------------------- trends
    const months = lastNMonths(12);
    const collections = Object.fromEntries(db.all(
      `SELECT substr(paid_on,1,7) AS m, SUM(amount) AS total
         FROM payments WHERE voided = 0 GROUP BY m`).map((r) => [r.m, money(r.total)]));
    const spend = Object.fromEntries(db.all(
      `SELECT substr(spent_on,1,7) AS m, SUM(amount) AS total
         FROM expenses GROUP BY m`).map((r) => [r.m, money(r.total)]));
    const admissions = Object.fromEntries(db.all(
      `SELECT substr(joined_on,1,7) AS m, COUNT(*) AS total
         FROM students WHERE joined_on IS NOT NULL GROUP BY m`).map((r) => [r.m, r.total]));

    const trend = months.map((m) => ({
      month: m,
      collected: collections[m] || 0,
      expenses: spend[m] || 0,
      net: money((collections[m] || 0) - (spend[m] || 0)),
      admissions: admissions[m] || 0,
    }));

    // -------------------------------------------------------- breakdowns
    const byStage = db.all('SELECT stage, COUNT(*) c FROM students GROUP BY stage');
    const byCourse = db.all(
      `SELECT c.name, COUNT(e.id) AS students,
              COALESCE(SUM(e.net_fee),0) AS billed,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         JOIN enrollments e2 ON e2.id = p.enrollment_id
                        WHERE e2.course_id = c.id AND p.voided = 0), 0) AS collected
         FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id AND e.status <> 'Dropped'
        GROUP BY c.id HAVING students > 0 ORDER BY collected DESC LIMIT 8`,
    );
    for (const r of byCourse) { r.billed = money(r.billed); r.collected = money(r.collected); }

    const paymentModes = db.all(
      `SELECT mode, COUNT(*) AS count, SUM(amount) AS total
         FROM payments WHERE voided = 0 AND paid_on >= ? GROUP BY mode ORDER BY total DESC`, [mStart],
    ).map((r) => ({ ...r, total: money(r.total) }));

    const enquirySources = db.all(
      `SELECT COALESCE(source,'Unknown') AS source, COUNT(*) AS total,
              SUM(CASE WHEN status = 'Converted' THEN 1 ELSE 0 END) AS converted
         FROM enquiries GROUP BY source ORDER BY total DESC LIMIT 8`,
    );

    // ------------------------------------------------------ action lists
    const dueSoon = db.all(
      `SELECT i.id, i.label, i.amount, i.paid_amount, i.due_date,
              (i.amount - i.paid_amount) AS balance,
              s.id AS student_id, s.name AS student_name, s.reg_no, s.phone,
              c.name AS course_name,
              CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue
         FROM installments i
         JOIN enrollments e ON e.id = i.enrollment_id
         JOIN students s ON s.id = e.student_id
         JOIN courses c ON c.id = e.course_id
        WHERE i.status IN ('Pending','Partial') AND e.status <> 'Dropped'
          AND i.due_date <= date('now', '+' || ? || ' days')
        ORDER BY i.due_date ASC LIMIT 12`,
      [reminderDays],
    );

    const followupsDue = db.all(
      `SELECT e.id, e.name, e.phone, e.next_followup, e.priority, e.status,
              -- a lead can ask for something we do not run yet; that name is
              -- typed onto the enquiry and is just as much the answer here
              COALESCE(c.name, e.course_other) AS course_name, st.name AS assigned_name,
              CAST(julianday('now') - julianday(e.next_followup) AS INTEGER) AS days_late
         FROM enquiries e
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN staff st ON st.id = e.assigned_to
        WHERE e.next_followup <= date('now') AND e.status NOT IN ('Converted','Lost')
        ORDER BY e.next_followup ASC LIMIT 12`,
    );

    const startingSoon = db.all(
      `SELECT b.id, b.code, b.start_date, b.capacity, b.time_slot, c.name AS course_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = b.id) AS filled
         FROM batches b JOIN courses c ON c.id = b.course_id
        WHERE b.status = 'Planned' AND b.start_date >= date('now')
        ORDER BY b.start_date ASC LIMIT 6`,
    );
    for (const b of startingSoon) b.seats_left = Math.max(0, b.capacity - b.filled);

    const recentPayments = db.all(
      `SELECT p.id, p.receipt_no, p.amount, p.mode, p.paid_on,
              s.name AS student_name, s.reg_no, c.name AS course_name
         FROM payments p
         JOIN students s ON s.id = p.student_id
         JOIN enrollments e ON e.id = p.enrollment_id
         JOIN courses c ON c.id = e.course_id
        WHERE p.voided = 0 ORDER BY p.id DESC LIMIT 8`,
    );

    const activity = db.all(
      'SELECT id, user_name, action, entity, entity_id, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 12',
    );

    // -------------------------------------------------------- alerts
    const alerts = [];
    if (kpis.overdue_amount > 0) {
      alerts.push({
        level: 'danger',
        title: `₹${kpis.overdue_amount.toLocaleString('en-IN')} overdue`,
        detail: `${kpis.overdue_count} student(s) have fees past their due date.`,
        link: '#/fees?overdue=1',
      });
    }
    if (kpis.enquiries_due > 0) {
      alerts.push({
        level: 'warn',
        title: `${kpis.enquiries_due} follow-up(s) due`,
        detail: 'Leads are waiting on a call today or earlier.',
        link: '#/enquiries?due=1',
      });
    }
    /*
     * No "nearly full" alert. A batch filling up is not a problem to be told
     * about — the seats left are already on the batch row and on the batch
     * itself, which is where you would go to do anything about it. It only
     * pushed the alerts that do need acting on further down the screen.
     */
    const unassigned = db.scalar(
      "SELECT COUNT(*) c FROM enrollments WHERE batch_id IS NULL AND status = 'Active'");
    if (unassigned > 0) {
      alerts.push({
        level: 'warn',
        title: `${unassigned} enrollment(s) without a batch`,
        detail: 'Assign these students to a batch so attendance can be tracked.',
        link: '#/enrollments?unassigned=1',
      });
    }

    return {
      generated_at: new Date().toISOString(),
      kpis,
      trend,
      by_stage: byStage,
      by_course: byCourse,
      payment_modes: paymentModes,
      enquiry_sources: enquirySources,
      due_soon: dueSoon,
      followups_due: followupsDue,
      starting_soon: startingSoon,
      recent_payments: recentPayments,
      activity,
      alerts,
    };
  });

  /** Cross-module search for the top bar. */
  router.get('/api/search', ({ query }) => {
    const q = String(query.q || '').trim();
    if (q.length < 2) return { results: [] };
    const like = `%${q}%`;
    const results = [];

    for (const r of db.all(
      `SELECT id, reg_no, name, phone, stage FROM students
        WHERE name LIKE ? OR reg_no LIKE ? OR phone LIKE ? OR email LIKE ? LIMIT 8`,
      [like, like, like, like],
    )) {
      results.push({ type: 'Student', id: r.id, title: r.name, subtitle: `${r.reg_no} · ${r.phone} · ${r.stage}`, link: `#/students/${r.id}` });
    }
    for (const r of db.all(
      'SELECT id, name, phone, status FROM enquiries WHERE name LIKE ? OR phone LIKE ? LIMIT 5',
      [like, like],
    )) {
      results.push({ type: 'Enquiry', id: r.id, title: r.name, subtitle: `${r.phone} · ${r.status}`, link: `#/enquiries/${r.id}` });
    }
    for (const r of db.all(
      'SELECT id, code, name FROM courses WHERE name LIKE ? OR code LIKE ? LIMIT 5', [like, like],
    )) {
      results.push({ type: 'Course', id: r.id, title: r.name, subtitle: r.code, link: `#/courses/${r.id}` });
    }
    for (const r of db.all(
      `SELECT b.id, b.code, c.name AS course_name FROM batches b
         JOIN courses c ON c.id = b.course_id WHERE b.code LIKE ? LIMIT 5`, [like],
    )) {
      results.push({ type: 'Batch', id: r.id, title: r.code, subtitle: r.course_name, link: `#/batches/${r.id}` });
    }
    for (const r of db.all(
      `SELECT p.id, p.receipt_no, p.amount, s.name FROM payments p
         JOIN students s ON s.id = p.student_id WHERE p.receipt_no LIKE ? LIMIT 5`, [like],
    )) {
      results.push({ type: 'Receipt', id: r.id, title: r.receipt_no, subtitle: `${r.name} · ₹${r.amount}`, link: `#/payments/${r.id}` });
    }
    return { results };
  });
};
