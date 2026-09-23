'use strict';
/**
 * Fee structure.
 *
 *   fee_plans       — reusable per-course templates ("3 instalments")
 *   fee_plan_items  — the lines of a template, each with a due-day offset
 *   installments    — the live copy created on a student's enrollment
 *
 * A plan is a template only: editing it never rewrites a schedule that has
 * already been issued to a student.
 */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const settings = require('../settings');
const {
  required, str, money, nowIso, notFound, badRequest, bool, toDate, toCsv,
} = require('../util');
const { raw } = require('../router');

function planRow(id) {
  const p = db.get(
    `SELECT f.*, c.name AS course_name, c.code AS course_code
       FROM fee_plans f JOIN courses c ON c.id = f.course_id WHERE f.id = ?`, [id],
  );
  if (!p) throw notFound('Fee plan not found');
  p.items = db.all(
    'SELECT * FROM fee_plan_items WHERE fee_plan_id = ? ORDER BY sequence, id', [id],
  );
  p.items_total = money(p.items.reduce((s, i) => s + i.amount, 0));
  p.in_use = db.scalar('SELECT COUNT(*) c FROM enrollments WHERE fee_plan_id = ?', [id]);
  return p;
}

/** Normalise the incoming item list; auto-split when only a count is given. */
function resolveItems(body, total) {
  if (Array.isArray(body.items) && body.items.length) {
    return body.items.map((it, i) => ({
      sequence: Number(it.sequence) || i + 1,
      label: str(it.label) || `Instalment ${i + 1}`,
      amount: money(it.amount),
      due_offset_days: Number(it.due_offset_days) || 0,
    }));
  }
  const n = Math.max(1, Math.min(Number(body.installment_count) || 1, 24));
  const each = money(total / n);
  const items = [];
  for (let i = 0; i < n; i++) {
    // Push any rounding remainder onto the final instalment.
    const amount = i === n - 1 ? money(total - each * (n - 1)) : each;
    items.push({
      sequence: i + 1,
      label: n === 1 ? 'Full payment' : `Instalment ${i + 1}`,
      amount,
      due_offset_days: i * (Number(body.gap_days) || 30),
    });
  }
  return items;
}

function writeItems(planId, items) {
  db.run('DELETE FROM fee_plan_items WHERE fee_plan_id = ?', [planId]);
  for (const it of items) {
    db.run(
      `INSERT INTO fee_plan_items (fee_plan_id, sequence, label, amount, due_offset_days)
       VALUES (?,?,?,?,?)`,
      [planId, it.sequence, it.label, it.amount, it.due_offset_days],
    );
  }
}

module.exports = function register(router) {
  // ------------------------------------------------------- fee plans
  router.get('/api/fee-plans', ({ query }) => {
    const where = [];
    const args = [];
    if (query.course_id) { where.push('f.course_id = ?'); args.push(query.course_id); }
    if (query.active === '1') where.push('f.active = 1');
    return db.all(
      `SELECT f.*, c.name AS course_name, c.code AS course_code,
              (SELECT COUNT(*) FROM fee_plan_items i WHERE i.fee_plan_id = f.id)   AS item_count,
              (SELECT COUNT(*) FROM enrollments e WHERE e.fee_plan_id = f.id)      AS in_use
         FROM fee_plans f JOIN courses c ON c.id = f.course_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.name, f.active DESC, f.name`,
      args,
    );
  });

  router.get('/api/fee-plans/:id', ({ params }) => planRow(params.id));

  router.post('/api/fee-plans', ({ user, body }) => {
    requireWrite(user, 'fees');
    required(body, ['course_id', 'name']);
    if (!db.get('SELECT id FROM courses WHERE id = ?', [body.course_id])) {
      throw badRequest('Pick a valid course', { course_id: 'Required' });
    }
    const total = money(body.total_fee);
    if (total <= 0) throw badRequest('Total fee must be greater than zero', { total_fee: 'Enter an amount' });

    const items = resolveItems(body, total);
    const sum = money(items.reduce((s, i) => s + i.amount, 0));
    if (Math.abs(sum - total) > 0.01) {
      throw badRequest(`Instalments add up to ₹${sum} but the total fee is ₹${total}.`);
    }

    return db.tx(() => {
      const { lastInsertRowid: id } = db.run(
        `INSERT INTO fee_plans (course_id, name, total_fee, tax_percent, active, notes, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        // a new plan carries the institute GST rate unless one is given
        [body.course_id, str(body.name), total,
          money(body.tax_percent === undefined ? settings.get('default_tax_percent') : body.tax_percent),
          body.active === undefined ? 1 : bool(body.active), str(body.notes), nowIso()],
      );
      writeItems(id, items);
      audit(user, 'create', 'fee_plans', id, `${body.name} — ₹${total}`);
      return planRow(id);
    });
  });

  router.put('/api/fee-plans/:id', ({ user, params, body }) => {
    requireWrite(user, 'fees');
    const p = db.get('SELECT * FROM fee_plans WHERE id = ?', [params.id]);
    if (!p) throw notFound('Fee plan not found');
    const total = body.total_fee === undefined ? p.total_fee : money(body.total_fee);

    return db.tx(() => {
      db.run(
        'UPDATE fee_plans SET name=?, total_fee=?, tax_percent=?, active=?, notes=? WHERE id=?',
        [
          str(body.name) || p.name, total,
          body.tax_percent === undefined ? p.tax_percent : money(body.tax_percent),
          body.active === undefined ? p.active : bool(body.active),
          str(body.notes), params.id,
        ],
      );
      if (body.items || body.installment_count) {
        const items = resolveItems(body, total);
        const sum = money(items.reduce((s, i) => s + i.amount, 0));
        if (Math.abs(sum - total) > 0.01) {
          throw badRequest(`Instalments add up to ₹${sum} but the total fee is ₹${total}.`);
        }
        writeItems(params.id, items);
      }
      audit(user, 'update', 'fee_plans', params.id, str(body.name) || p.name);
      return planRow(params.id);
    });
  });

  router.del('/api/fee-plans/:id', ({ user, params }) => {
    requireWrite(user, 'fees');
    const p = db.get('SELECT * FROM fee_plans WHERE id = ?', [params.id]);
    if (!p) throw notFound('Fee plan not found');
    const used = db.scalar('SELECT COUNT(*) c FROM enrollments WHERE fee_plan_id = ?', [params.id]);
    if (used) throw badRequest(`${used} enrollment(s) use this plan. Mark it inactive instead of deleting.`);
    db.run('DELETE FROM fee_plans WHERE id = ?', [params.id]);
    audit(user, 'delete', 'fee_plans', params.id, p.name);
    return { ok: true };
  });

  // ---------------------------------------------------- outstanding
  router.get('/api/fees/outstanding', ({ query }) => {
    const where = ["i.status IN ('Pending','Partial')", "e.status <> 'Dropped'"];
    const args = [];
    if (query.overdue === '1') where.push("i.due_date < date('now')");
    if (query.batch_id) { where.push('e.batch_id = ?'); args.push(query.batch_id); }
    if (query.course_id) { where.push('e.course_id = ?'); args.push(query.course_id); }
    if (query.q) {
      where.push('(s.name LIKE ? OR s.reg_no LIKE ? OR s.phone LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like);
    }
    const rows = db.all(
      `SELECT i.id, i.sequence, i.label, i.amount, i.paid_amount, i.due_date, i.status,
              (i.amount - i.paid_amount) AS balance,
              CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue,
              e.id AS enrollment_id, c.name AS course_name,
              b.code AS batch_code, b.start_date AS batch_start,
              s.id AS student_id, s.reg_no, s.name AS student_name, s.phone, s.email
         FROM installments i
         JOIN enrollments e ON e.id = i.enrollment_id
         JOIN students s ON s.id = e.student_id
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN batches b ON b.id = e.batch_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.due_date ASC, s.name`,
      args,
    );
    const totals = rows.reduce((a, r) => {
      a.balance = money(a.balance + r.balance);
      if (r.days_overdue > 0) a.overdue = money(a.overdue + r.balance);
      return a;
    }, { balance: 0, overdue: 0 });
    return { rows, totals, count: rows.length };
  });

  router.get('/api/fees/outstanding/export', () => {
    const rows = db.all(
      `SELECT s.reg_no, s.name AS student, s.phone, c.name AS course, b.code AS batch,
              i.label, i.amount, i.paid_amount, (i.amount - i.paid_amount) AS balance,
              i.due_date, i.status
         FROM installments i
         JOIN enrollments e ON e.id = i.enrollment_id
         JOIN students s ON s.id = e.student_id
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN batches b ON b.id = e.batch_id
        WHERE i.status IN ('Pending','Partial') AND e.status <> 'Dropped'
        ORDER BY i.due_date`,
    );
    return raw(toCsv(rows), 'text/csv; charset=utf-8', 'dhishaai-outstanding-fees.csv');
  });

  // --------------------------------------------------- installments
  router.put('/api/installments/:id', ({ user, params, body }) => {
    requireWrite(user, 'installments');
    const i = db.get('SELECT * FROM installments WHERE id = ?', [params.id]);
    if (!i) throw notFound('Instalment not found');
    const amount = body.amount === undefined ? i.amount : money(body.amount);
    if (amount < i.paid_amount) {
      throw badRequest(`₹${i.paid_amount} is already paid against this instalment; the amount cannot be lower.`);
    }
    const status = i.status === 'Waived' ? 'Waived'
      : amount <= i.paid_amount ? 'Paid'
        : i.paid_amount > 0 ? 'Partial' : 'Pending';
    db.run(
      'UPDATE installments SET label=?, amount=?, due_date=?, status=? WHERE id=?',
      [str(body.label) || i.label, amount, toDate(body.due_date) || i.due_date, status, params.id],
    );
    audit(user, 'update', 'installments', params.id, `₹${amount} due ${toDate(body.due_date) || i.due_date}`);
    return db.get('SELECT * FROM installments WHERE id = ?', [params.id]);
  });

  router.post('/api/installments/:id/waive', ({ user, params, body }) => {
    requireWrite(user, 'installments');
    required(body, ['reason']);
    const i = db.get('SELECT * FROM installments WHERE id = ?', [params.id]);
    if (!i) throw notFound('Instalment not found');
    if (i.status === 'Paid') throw badRequest('This instalment is already fully paid.');

    return db.tx(() => {
      db.run(
        "UPDATE installments SET status = 'Waived', waived_note = ? WHERE id = ?",
        [str(body.reason), params.id],
      );
      // A waiver reduces the net fee owed on the enrollment.
      const waived = money(i.amount - i.paid_amount);
      db.run(
        `UPDATE enrollments
            SET discount = discount + ?, net_fee = net_fee - ?,
                discount_note = COALESCE(discount_note || ' | ', '') || ?
          WHERE id = ?`,
        [waived, waived, `Waived ${i.label}: ${str(body.reason)}`, i.enrollment_id],
      );
      audit(user, 'update', 'installments', params.id, `waived ₹${waived} — ${str(body.reason)}`);
      return { ok: true, waived };
    });
  });

  router.post('/api/installments/:id/unwaive', ({ user, params }) => {
    requireWrite(user, 'installments');
    const i = db.get('SELECT * FROM installments WHERE id = ?', [params.id]);
    if (!i) throw notFound('Instalment not found');
    if (i.status !== 'Waived') throw badRequest('This instalment is not waived.');

    return db.tx(() => {
      const restored = money(i.amount - i.paid_amount);
      db.run(
        "UPDATE installments SET status = ?, waived_note = NULL WHERE id = ?",
        [i.paid_amount > 0 ? 'Partial' : 'Pending', params.id],
      );
      db.run(
        'UPDATE enrollments SET discount = MAX(0, discount - ?), net_fee = net_fee + ? WHERE id = ?',
        [restored, restored, i.enrollment_id],
      );
      audit(user, 'update', 'installments', params.id, `waiver reversed (₹${restored})`);
      return { ok: true };
    });
  });
};
