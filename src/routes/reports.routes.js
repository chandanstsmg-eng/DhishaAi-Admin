'use strict';
/**
 * Reporting. Every report returns the same envelope:
 *   { title, columns:[{key,label,type}], rows:[...], totals:{}, chart:{} }
 * so one screen and one CSV exporter can render all of them.
 */

const { db } = require('../db');
const C = require('../constants');
const { money, today, toDate, toCsv, badRequest, monthsBetween } = require('../util');
const { raw } = require('../router');

const col = (key, label, type = 'text') => ({ key, label, type });

function range(query) {
  const to = toDate(query.to) || today();
  const from = toDate(query.from) || `${new Date().getFullYear()}-01-01`;
  if (from > to) throw badRequest('The "from" date is after the "to" date');
  return { from, to };
}

// --------------------------------------------------------------- reports
const REPORTS = {
  // Collections grouped by calendar month.
  collections_monthly({ from, to }) {
    const rows = db.all(
      `SELECT substr(p.paid_on,1,7) AS period,
              COUNT(*) AS receipts,
              COUNT(DISTINCT p.student_id) AS students,
              SUM(p.amount) AS collected
         FROM payments p
        WHERE p.voided = 0 AND p.paid_on BETWEEN ? AND ?
        GROUP BY period ORDER BY period`, [from, to],
    );
    const expenses = Object.fromEntries(db.all(
      `SELECT substr(spent_on,1,7) AS period, SUM(amount) AS spent
         FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY period`, [from, to],
    ).map((r) => [r.period, money(r.spent)]));
    for (const r of rows) {
      r.collected = money(r.collected);
      r.expenses = expenses[r.period] || 0;
      r.net = money(r.collected - r.expenses);
    }
    return {
      title: 'Collections by month',
      columns: [
        col('period', 'Month'), col('receipts', 'Receipts', 'number'),
        col('students', 'Students', 'number'), col('collected', 'Collected', 'money'),
        col('expenses', 'Expenses', 'money'), col('net', 'Net', 'money'),
      ],
      rows,
      totals: {
        collected: money(rows.reduce((s, r) => s + r.collected, 0)),
        expenses: money(rows.reduce((s, r) => s + r.expenses, 0)),
        net: money(rows.reduce((s, r) => s + r.net, 0)),
        receipts: rows.reduce((s, r) => s + r.receipts, 0),
      },
      chart: { type: 'bars', x: 'period', series: [{ key: 'collected', label: 'Collected' }, { key: 'expenses', label: 'Expenses' }] },
    };
  },

  // Money performance per course.
  course_revenue({ from, to }) {
    const rows = db.all(
      `SELECT c.code, c.name AS course,
              COUNT(DISTINCT e.id) AS enrollments,
              COALESCE(SUM(e.gross_fee),0)  AS gross,
              COALESCE(SUM(e.discount),0)   AS discount,
              COALESCE(SUM(e.net_fee),0)    AS billed
         FROM courses c
         LEFT JOIN enrollments e ON e.course_id = c.id AND e.status <> 'Dropped'
                                AND e.enrolled_on BETWEEN ? AND ?
        GROUP BY c.id ORDER BY billed DESC`, [from, to],
    );
    const collected = Object.fromEntries(db.all(
      `SELECT e.course_id AS cid, SUM(p.amount) AS total
         FROM payments p JOIN enrollments e ON e.id = p.enrollment_id
        WHERE p.voided = 0 AND p.paid_on BETWEEN ? AND ? GROUP BY cid`, [from, to],
    ).map((r) => [r.cid, money(r.total)]));
    const ids = db.all('SELECT id, code FROM courses');
    const codeToId = Object.fromEntries(ids.map((r) => [r.code, r.id]));
    for (const r of rows) {
      r.gross = money(r.gross); r.discount = money(r.discount); r.billed = money(r.billed);
      r.collected = collected[codeToId[r.code]] || 0;
      r.outstanding = money(r.billed - r.collected);
    }
    return {
      title: 'Revenue by course',
      columns: [
        col('code', 'Code'), col('course', 'Course'), col('enrollments', 'Enrolled', 'number'),
        col('gross', 'Gross', 'money'), col('discount', 'Discount', 'money'),
        col('billed', 'Billed', 'money'), col('collected', 'Collected', 'money'),
        col('outstanding', 'Outstanding', 'money'),
      ],
      rows,
      totals: {
        billed: money(rows.reduce((s, r) => s + r.billed, 0)),
        collected: money(rows.reduce((s, r) => s + r.collected, 0)),
        outstanding: money(rows.reduce((s, r) => s + r.outstanding, 0)),
      },
      chart: { type: 'bars', x: 'course', series: [{ key: 'collected', label: 'Collected' }, { key: 'outstanding', label: 'Outstanding' }] },
    };
  },

  /*
   * How long money has been sitting unpaid, for the instalments falling due in
   * the chosen range.
   *
   * The buckets stay measured against today — that is what ageing means — while
   * the range picks which instalments are counted. Note the consequence: with a
   * range that ends today, "Not yet due" is empty by definition, because
   * nothing due in the past can still be upcoming. Push the "to" date forward
   * to bring the coming instalments back into view.
   */
  fee_aging({ from, to }) {
    // Each label says what it means on its own, so a row lifted out of the
    // table into an email still reads: "1–15 days late", not "1 – 15 days".
    const buckets = [
      ['Not due yet', 'i.due_date >= date(\'now\')'],
      ['1–15 days late', "i.due_date < date('now') AND i.due_date >= date('now','-15 days')"],
      ['16–30 days late', "i.due_date < date('now','-15 days') AND i.due_date >= date('now','-30 days')"],
      ['31–60 days late', "i.due_date < date('now','-30 days') AND i.due_date >= date('now','-60 days')"],
      ['Over 60 days late', "i.due_date < date('now','-60 days')"],
    ];
    const rows = buckets.map(([bucket, cond]) => {
      const r = db.get(
        `SELECT COUNT(*) AS items, COUNT(DISTINCT e.student_id) AS students,
                COALESCE(SUM(i.amount - i.paid_amount),0) AS balance
           FROM installments i JOIN enrollments e ON e.id = i.enrollment_id
          WHERE i.status IN ('Pending','Partial') AND e.status <> 'Dropped'
            AND i.due_date BETWEEN ? AND ?
            AND ${cond}`, [from, to],
      );
      return { bucket, items: r.items, students: r.students, unpaid: money(r.balance) };
    });
    return {
      title: 'Unpaid fee by date',
      columns: [
        col('bucket', 'How late'), col('students', 'Students', 'number'),
        col('items', 'Instalments', 'number'), col('unpaid', 'Amount unpaid', 'money'),
      ],
      rows,
      totals: { unpaid: money(rows.reduce((s, r) => s + r.unpaid, 0)) },
      chart: { type: 'bars', x: 'bucket', series: [{ key: 'unpaid', label: 'Amount unpaid' }] },
    };
  },

  /*
   * Leads in against admissions out, by month, over the chosen range.
   *
   * The percentage is a cohort figure, and it has to be: of the enquiries
   * raised in a month, how many of those same people have since enrolled. It
   * used to divide the month's admissions by the month's enquiries, which are
   * two different sets of people — someone who enquired in March and joined in
   * May counts on one side only, and a student who never enquired at all counts
   * on neither. That produced readings like "120%", which is not a conversion
   * rate at all. Measured against its own cohort the figure cannot pass 100.
   *
   * Admissions stays on the row because it is worth seeing, but it is a
   * separate count and is no longer part of the division.
   *
   * Months are laid out from the range rather than the data, so a month with
   * no enquiries shows as a zero instead of vanishing from the axis.
   */
  admissions({ from, to }) {
    const months = monthsBetween(from, to);
    const counts = Object.fromEntries(db.all(
      `SELECT substr(joined_on,1,7) AS period, COUNT(*) AS admissions
         FROM students
        WHERE joined_on IS NOT NULL AND joined_on BETWEEN ? AND ?
        GROUP BY period`, [from, to],
    ).map((r) => [r.period, r.admissions]));
    // created_at carries a time, so it is reduced to a date before comparing —
    // otherwise "2026-07-30T14:02:11" sorts past a "to" of "2026-07-30" and the
    // last day of every range would be silently dropped.
    const enq = Object.fromEntries(db.all(
      `SELECT substr(created_at,1,7) AS period,
              COUNT(*) AS enquiries,
              SUM(CASE WHEN status = 'Converted' THEN 1 ELSE 0 END) AS converted
         FROM enquiries
        WHERE date(created_at) BETWEEN ? AND ?
        GROUP BY period`, [from, to],
    ).map((r) => [r.period, r]));
    const rows = months.map((m) => {
      const admissions = counts[m] || 0;
      const enquiries = enq[m] ? enq[m].enquiries : 0;
      const converted = enq[m] ? enq[m].converted : 0;
      return {
        period: m, enquiries, converted, admissions,
        conversion: enquiries ? `${Math.round((converted / enquiries) * 100)}%` : '—',
      };
    });
    return {
      title: 'Admissions vs enquiries',
      columns: [
        col('period', 'Month'), col('enquiries', 'Enquiries', 'number'),
        col('converted', 'Of those, enrolled', 'number'),
        col('admissions', 'Admissions', 'number'), col('conversion', 'Lead conversion'),
      ],
      rows,
      totals: {
        enquiries: rows.reduce((s, r) => s + r.enquiries, 0),
        converted: rows.reduce((s, r) => s + r.converted, 0),
        admissions: rows.reduce((s, r) => s + r.admissions, 0),
      },
      chart: {
        type: 'bars',
        x: 'period',
        series: [
          { key: 'enquiries', label: 'Enquiries' },
          { key: 'converted', label: 'Of those, enrolled' },
          { key: 'admissions', label: 'Admissions' },
        ],
      },
    };
  },

  /*
   * Batch health — fill rate, attendance, money — for the batches starting in
   * the chosen range.
   *
   * Start date is the only date a batch has that places it in time, and it is
   * what the rows are already ordered by. The figures on each row stay
   * whole-batch figures: half an intake's attendance is not its attendance.
   */
  batch_performance({ from, to }) {
    const rows = db.all(
      `SELECT b.code AS batch, c.name AS course, st.name AS trainer, b.status,
              b.start_date, b.capacity,
              (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = b.id) AS enrolled,
              COALESCE((SELECT SUM(e.net_fee) FROM enrollments e
                         WHERE e.batch_id = b.id AND e.status <> 'Dropped'),0) AS billed,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         JOIN enrollments e ON e.id = p.enrollment_id
                        WHERE e.batch_id = b.id AND p.voided = 0),0) AS collected,
              -- present + absent only, the same rule the attendance screen
              -- uses; see COUNTED_SQL in constants.js for why a cancelled or
              -- excused session is out of the denominator as well as the top.
              (SELECT COUNT(*) FROM attendance a WHERE a.batch_id = b.id
                 AND a.status ${C.COUNTED_SQL}) AS marks,
              (SELECT COUNT(*) FROM attendance a WHERE a.batch_id = b.id
                 AND a.status IN ('Present','Late')) AS attended
         FROM batches b JOIN courses c ON c.id = b.course_id
         LEFT JOIN staff st ON st.id = b.trainer_id
        WHERE b.start_date BETWEEN ? AND ?
        ORDER BY b.start_date DESC`, [from, to],
    );
    for (const r of rows) {
      r.billed = money(r.billed);
      r.collected = money(r.collected);
      r.outstanding = money(r.billed - r.collected);
      /*
       * Two forms of the same figure: a string for the table, and a number for
       * the chart. null rather than 0 where there is nothing to measure — a
       * batch with no attendance marked has not scored zero.
       */
      r.fill_pct = r.capacity ? Math.round((r.enrolled / r.capacity) * 100) : null;
      r.attendance_pct = r.marks ? Math.round((r.attended / r.marks) * 100) : null;
      r.fill_rate = r.fill_pct == null ? '—' : `${r.fill_pct}%`;
      r.attendance = r.attendance_pct == null ? '—' : `${r.attendance_pct}%`;
      delete r.marks; delete r.attended;
    }
    return {
      title: 'Batch performance',
      columns: [
        col('batch', 'Batch'), col('course', 'Course'), col('trainer', 'Trainer'),
        col('status', 'Status'), col('start_date', 'Starts', 'date'),
        col('enrolled', 'Enrolled', 'number'), col('fill_rate', 'Fill'),
        col('attendance', 'Attendance'), col('billed', 'Billed', 'money'),
        col('collected', 'Collected', 'money'), col('outstanding', 'Outstanding', 'money'),
      ],
      rows,
      /*
       * Two charts, not one with two scales: rupees and percentages cannot
       * share a value axis without one of them lying about the other.
       */
      charts: [
        {
          title: 'Billed against collected',
          x: 'batch',
          format: 'money',
          series: [{ key: 'billed', label: 'Billed' }, { key: 'collected', label: 'Collected' }],
        },
        {
          title: 'Seats filled and attendance',
          x: 'batch',
          format: 'percent',
          max: 100,
          series: [{ key: 'fill_pct', label: 'Fill' }, { key: 'attendance_pct', label: 'Attendance' }],
        },
      ],
      totals: {
        billed: money(rows.reduce((s, r) => s + r.billed, 0)),
        collected: money(rows.reduce((s, r) => s + r.collected, 0)),
      },
    };
  },

  /*
   * Where leads come from and which sources actually convert, over the chosen
   * range.
   *
   * The range is on when the enquiry arrived, so each row is a cohort: of the
   * leads this source brought in during the window, how many have since become
   * students. Dating the conversions instead would let a source show more
   * conversions than enquiries — the trap the admissions report has by month.
   */
  lead_sources({ from, to }) {
    const rows = db.all(
      `SELECT COALESCE(e.source,'Unknown') AS source,
              COUNT(*) AS enquiries,
              SUM(CASE WHEN e.status = 'Converted' THEN 1 ELSE 0 END) AS converted,
              SUM(CASE WHEN e.status = 'Lost' THEN 1 ELSE 0 END) AS lost
         FROM enquiries e
        WHERE date(e.created_at) BETWEEN ? AND ?
        GROUP BY source ORDER BY enquiries DESC`, [from, to],
    );
    for (const r of rows) {
      r.conversion = r.enquiries ? `${Math.round((r.converted / r.enquiries) * 100)}%` : '—';
    }
    return {
      title: 'Lead sources',
      columns: [
        col('source', 'Source'), col('enquiries', 'Enquiries', 'number'),
        col('converted', 'Converted', 'number'), col('lost', 'Lost', 'number'),
        col('conversion', 'Conversion'),
      ],
      rows,
      totals: {
        enquiries: rows.reduce((s, r) => s + r.enquiries, 0),
        converted: rows.reduce((s, r) => s + r.converted, 0),
      },
      chart: { type: 'bars', x: 'source', series: [{ key: 'enquiries', label: 'Enquiries' }, { key: 'converted', label: 'Converted' }] },
    };
  },

  // Day-book of receipts for reconciliation.
  daybook({ from, to }) {
    const rows = db.all(
      `SELECT p.paid_on AS date, p.receipt_no, s.reg_no, s.name AS student,
              c.name AS course, p.mode, p.reference, p.amount, p.collected_by
         FROM payments p
         JOIN students s ON s.id = p.student_id
         JOIN enrollments e ON e.id = p.enrollment_id
         JOIN courses c ON c.id = e.course_id
        WHERE p.voided = 0 AND p.paid_on BETWEEN ? AND ?
        ORDER BY p.paid_on DESC, p.id DESC`, [from, to],
    );
    for (const r of rows) r.amount = money(r.amount);
    return {
      title: 'Receipt day book',
      columns: [
        col('date', 'Date', 'date'), col('receipt_no', 'Receipt'), col('reg_no', 'Reg. no'),
        col('student', 'Student'), col('course', 'Course'), col('mode', 'Mode'),
        col('reference', 'Reference'), col('amount', 'Amount', 'money'),
        col('collected_by', 'Collected by'),
      ],
      rows,
      totals: { amount: money(rows.reduce((s, r) => s + r.amount, 0)) },
    };
  },

  /*
   * Student-level ledger: billed, paid, balance, for the students who joined
   * within the chosen range.
   *
   * The range picks the students, not the payments. Each student's figures stay
   * lifetime figures — restricting the payments to a window would leave a
   * balance of lifetime-billed minus window-paid, which is not a balance at all
   * and would read as money owed that has in fact been collected. A student
   * with no joining date on record cannot be placed in time and so falls
   * outside any range.
   */
  student_ledger({ from, to }) {
    const rows = db.all(
      `SELECT s.reg_no, s.name AS student, s.phone, s.status, s.stage,
              COALESCE(SUM(e.net_fee),0) AS billed,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         WHERE p.student_id = s.id AND p.voided = 0),0) AS paid
         FROM students s
         LEFT JOIN enrollments e ON e.student_id = s.id AND e.status <> 'Dropped'
        WHERE s.joined_on IS NOT NULL AND s.joined_on BETWEEN ? AND ?
        GROUP BY s.id ORDER BY (billed - paid) DESC`, [from, to],
    );
    for (const r of rows) {
      r.billed = money(r.billed);
      r.paid = money(r.paid);
      r.balance = money(r.billed - r.paid);
    }
    return {
      title: 'Student fee ledger',
      columns: [
        col('reg_no', 'Reg. no'), col('student', 'Student'), col('phone', 'Phone'),
        col('status', 'Status'), col('stage', 'Stage'), col('billed', 'Billed', 'money'),
        col('paid', 'Paid', 'money'), col('balance', 'Balance', 'money'),
      ],
      rows,
      totals: {
        billed: money(rows.reduce((s, r) => s + r.billed, 0)),
        paid: money(rows.reduce((s, r) => s + r.paid, 0)),
        balance: money(rows.reduce((s, r) => s + r.balance, 0)),
      },
    };
  },

  // Simple cash view: money in vs money out.
  profit_loss({ from, to }) {
    const income = money(db.scalar(
      'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE voided = 0 AND paid_on BETWEEN ? AND ?',
      [from, to]));
    const byCat = db.all(
      `SELECT category, SUM(amount) AS amount FROM expenses
        WHERE spent_on BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC`, [from, to],
    ).map((r) => ({ line: r.category, type: 'Expense', amount: money(r.amount) }));
    const rows = [{ line: 'Fee collections', type: 'Income', amount: income }, ...byCat];
    const spend = money(byCat.reduce((s, r) => s + r.amount, 0));
    return {
      title: 'Cash summary',
      columns: [col('line', 'Line'), col('type', 'Type'), col('amount', 'Amount', 'money')],
      rows,
      totals: { income, expenses: spend, net: money(income - spend) },
      chart: { type: 'bars', x: 'line', series: [{ key: 'amount', label: 'Amount' }] },
    };
  },
};

const CATALOGUE = [
  { key: 'collections_monthly', name: 'Collections by month', group: 'Finance', dated: true },
  { key: 'daybook', name: 'Receipt day book', group: 'Finance', dated: true },
  { key: 'profit_loss', name: 'Cash summary', group: 'Finance', dated: true },
  { key: 'fee_aging', name: 'Unpaid fee by date', group: 'Finance', dated: true },
  { key: 'student_ledger', name: 'Student fee ledger', group: 'Finance', dated: true },
  { key: 'course_revenue', name: 'Revenue by course', group: 'Academics', dated: true },
  { key: 'batch_performance', name: 'Batch performance', group: 'Academics', dated: true },
  { key: 'admissions', name: 'Admissions vs enquiries', group: 'Growth', dated: true },
  { key: 'lead_sources', name: 'Lead sources', group: 'Growth', dated: true },
];

module.exports = function register(router) {
  router.get('/api/reports', () => ({ reports: CATALOGUE }));

  router.get('/api/reports/:key', ({ params, query }) => {
    const fn = REPORTS[params.key];
    if (!fn) throw badRequest(`Unknown report "${params.key}"`);
    const r = range(query);
    return { key: params.key, from: r.from, to: r.to, ...fn(r, query) };
  });

  router.get('/api/reports/:key/export', ({ params, query }) => {
    const fn = REPORTS[params.key];
    if (!fn) throw badRequest(`Unknown report "${params.key}"`);
    const out = fn(range(query), query);
    return raw(
      toCsv(out.rows, out.columns.map((c) => ({ key: c.key, label: c.label }))),
      'text/csv; charset=utf-8',
      `dhishaai-${params.key}-${today()}.csv`,
    );
  });
};
