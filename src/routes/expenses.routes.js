'use strict';
/** Operating expenses — the other half of the P&L view on the dashboard. */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const C = require('../constants');
const {
  required, str, money, nowIso, today, toDate, notFound, badRequest, oneOf, toCsv,
} = require('../util');
const { raw } = require('../router');

module.exports = function register(router) {
  router.get('/api/expenses', ({ query }) => {
    const where = [];
    const args = [];
    if (query.category) { where.push('category = ?'); args.push(query.category); }
    if (query.from) { where.push('spent_on >= ?'); args.push(toDate(query.from)); }
    if (query.to) { where.push('spent_on <= ?'); args.push(toDate(query.to)); }
    if (query.q) {
      where.push('(vendor LIKE ? OR remarks LIKE ? OR reference LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like);
    }
    const rows = db.all(
      `SELECT * FROM expenses ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY spent_on DESC, id DESC LIMIT 500`, args,
    );
    const byCategory = {};
    for (const r of rows) byCategory[r.category] = money((byCategory[r.category] || 0) + r.amount);
    /*
     * How many exist at all, ignoring the filter. The screen opens on the
     * current month, so a register full of earlier entries showed as an empty
     * table with nothing to say the rest were simply out of range — it read as
     * "there are no expenses recorded" rather than "none this month".
     */
    const allTime = db.get('SELECT COUNT(*) c, MIN(spent_on) first, MAX(spent_on) last FROM expenses');
    return {
      rows,
      total: money(rows.reduce((s, r) => s + r.amount, 0)),
      by_category: byCategory,
      categories: C.EXPENSE_CATEGORIES,
      all_time: { count: allTime.c, first: allTime.first, last: allTime.last },
    };
  });

  router.get('/api/expenses/export', () => {
    const rows = db.all('SELECT spent_on, category, amount, mode, vendor, reference, remarks FROM expenses ORDER BY spent_on DESC');
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `dhishaai-expenses-${today()}.csv`);
  });

  router.post('/api/expenses', ({ user, body }) => {
    requireWrite(user, 'expenses');
    required(body, ['category', 'amount']);
    const amount = money(body.amount);
    if (amount <= 0) throw badRequest('Amount must be greater than zero', { amount: 'Enter an amount' });
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO expenses (spent_on, category, amount, mode, vendor, reference, remarks, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        toDate(body.spent_on) || today(), oneOf(body.category, C.EXPENSE_CATEGORIES, 'Misc'),
        amount, str(body.mode) || 'Bank Transfer', str(body.vendor),
        str(body.reference), str(body.remarks), nowIso(),
      ],
    );
    audit(user, 'create', 'expenses', id, `${body.category} ₹${amount}`);
    return db.get('SELECT * FROM expenses WHERE id = ?', [id]);
  });

  router.put('/api/expenses/:id', ({ user, params, body }) => {
    requireWrite(user, 'expenses');
    const e = db.get('SELECT * FROM expenses WHERE id = ?', [params.id]);
    if (!e) throw notFound('Expense not found');
    db.run(
      'UPDATE expenses SET spent_on=?, category=?, amount=?, mode=?, vendor=?, reference=?, remarks=? WHERE id=?',
      [
        toDate(body.spent_on) || e.spent_on, oneOf(body.category, C.EXPENSE_CATEGORIES, e.category),
        body.amount === undefined ? e.amount : money(body.amount),
        str(body.mode) || e.mode, str(body.vendor), str(body.reference), str(body.remarks), params.id,
      ],
    );
    audit(user, 'update', 'expenses', params.id, e.category);
    return db.get('SELECT * FROM expenses WHERE id = ?', [params.id]);
  });

  router.del('/api/expenses/:id', ({ user, params }) => {
    requireWrite(user, 'expenses');
    db.run('DELETE FROM expenses WHERE id = ?', [params.id]);
    audit(user, 'delete', 'expenses', params.id, null);
    return { ok: true };
  });
};
