'use strict';
/**
 * Payments. A payment is recorded against an enrollment and then allocated
 * across that enrollment's open instalments (oldest due first, unless the
 * caller supplies an explicit allocation). Voiding reverses the allocation.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const settings = require('../settings');
const mailer = require('../mailer');
const C = require('../constants');
const {
  required, str, money, nowIso, today, toDate, notFound, badRequest, oneOf, toCsv, batchLabel,
  rupeesInWords, isEmail,
} = require('../util');
const { raw } = require('../router');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 2026-03-25 -> 25-03-2026, the way the printed bill reads. */
function billDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d || '');
}

const LOGO_FILE = path.join(__dirname, '..', '..', 'public', 'assets', 'img', 'dhishaai-logo.png');
let logoDataUri = null;

/**
 * For the emailed copy the logo has to travel with the message — a relative
 * URL resolves to nothing in a mail client. Read once and kept in memory.
 */
function logoSrc(embed) {
  if (!embed) return '/assets/img/dhishaai-logo.png';
  if (logoDataUri === null) {
    try {
      logoDataUri = `data:image/png;base64,${fs.readFileSync(LOGO_FILE).toString('base64')}`;
    } catch (_) {
      logoDataUri = '';   // no logo file: the bill still prints, just without it
    }
  }
  return logoDataUri;
}

/**
 * The printed bill, built once and used by both the receipt page and the
 * emailed copy — so what the student receives is what the office sees on
 * screen, bar the logo, which has to be embedded for email.
 */
function receiptHtml(id, { embedLogo = false } = {}) {
  const p = paymentRow(id);
  const s = settings.all();
  const cur = s.currency || '₹';
  const amt = (n) => Number(money(n)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const enr = db.get('SELECT * FROM enrollments WHERE id = ?', [p.enrollment_id]);
  const paidTotal = money(db.scalar(
    'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE enrollment_id = ? AND voided = 0',
    [p.enrollment_id],
  ));

  // the charge, broken out the way the bill states it
  const gross = money(enr ? enr.gross_fee : p.amount);
  const discount = money(enr ? enr.discount : 0);
  const taxable = money(gross - discount);
  const taxPercent = enr ? enr.tax_percent : 0;
  const taxAmount = money(enr ? enr.tax_amount : 0);
  const total = money(enr ? enr.net_fee : p.amount);
  const roundOff = money(total - (taxable + taxAmount));
  const balance = money(total - paidTotal);

  const particulars = p.allocations.length
    ? p.allocations.map((a) => esc(a.label)).join(', ')
    : esc(p.course_name);

  const moneyRow = (label, value, cls = '') => `<tr class="${cls}">
      <td>${label}</td><td class="cur">${value == null ? '' : cur}</td>
      <td class="r">${value == null ? '' : amt(value)}</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bill ${esc(p.receipt_no)}</title>
<style>
 *{box-sizing:border-box}
 body{font:14px/1.5 "Segoe UI",Arial,sans-serif;color:#1b1b1b;margin:0;padding:28px;background:#f4f6f8}
 .sheet{max-width:820px;margin:0 auto;background:#fff;padding:38px 44px 46px;box-shadow:0 2px 14px rgba(0,0,0,.08)}
 /* Two columns that line up row by row, the way the printed bill does:
    the bill number sits low beside the logo, and GST starts level with the
    first line of the address. */
 .top{display:grid;grid-template-columns:1fr auto;column-gap:40px}
 .brand-logo{display:block;width:252px;height:auto}
 .logo-cell{align-self:end}
 .bill-cell{align-self:end;font-size:14px;white-space:nowrap;padding-bottom:8px;color:#333}
 .from{font-size:13.5px;color:#333;line-height:1.85;padding-top:14px}
 .gst-cell{font-size:13.5px;line-height:1.85;padding-top:14px;white-space:nowrap;color:#333}
 .lbl{font-weight:700;color:#7F6000}
 .date{font-weight:700;color:#7F6000;margin:20px 0 30px;font-size:14.5px}
 .parties{display:flex;gap:40px;margin-bottom:26px}
 .parties>div{flex:1}
 .parties h2{font:400 17px/1.3 Georgia,"Times New Roman",serif;color:#C0641E;margin:0 0 8px;letter-spacing:.5px}
 .parties p{margin:0;font-size:13.5px;line-height:1.7}
 table{width:100%;border-collapse:collapse}
 th{font-size:13.5px;font-weight:700;padding:8px 10px;text-align:left;border-bottom:2px solid #B79A3E}
 th.mid{text-align:center}th.r{text-align:right}
 td{padding:9px 10px;font-size:13.5px;border-bottom:1px solid #E4D9AE}
 td.cur{width:56px;text-align:left;color:#333}
 td.r{text-align:right;width:150px}
 tr.item td{border-bottom:1px solid #E4D9AE}
 tr.gap td{border:0;height:10px;padding:0}
 tr.total td{font-size:15px;font-weight:700;border-bottom:0;padding-top:20px;padding-bottom:20px}
 tr.total td:first-child{text-align:right;padding-right:26px}
 .amountcol{background:#FAFAF7}
 .words{margin-top:30px;font-size:13.5px}
 .terms{margin-top:22px;font-size:13.5px;color:#333}
 .contact{margin-top:20px;font-size:13.5px;color:#333}
 .thanks{margin-top:22px;font-weight:700;font-size:14px;letter-spacing:.3px}
 .void{position:fixed;top:42%;left:0;right:0;text-align:center;font-size:96px;font-weight:900;
       color:rgba(214,48,49,.13);transform:rotate(-18deg);letter-spacing:14px}
 .noprint{text-align:center;margin:0 0 18px}
 .noprint button{font:600 13px "Segoe UI";padding:9px 22px;border:0;border-radius:5px;background:#F47920;color:#fff;cursor:pointer}
 @media print{body{background:#fff;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
              .sheet{box-shadow:none;max-width:none;padding:24px}.noprint{display:none}}
</style></head><body>
${p.voided ? '<div class="void">VOID</div>' : ''}
<div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="sheet">
  <div class="top">
    <div class="logo-cell">
      <img class="brand-logo" src="${logoSrc(embedLogo)}" alt="${esc(s.institute_name)}">
    </div>
    <div class="bill-cell"><span class="lbl">Bill</span>&nbsp; #${esc(p.receipt_no)}</div>

    <div class="from">
      ${esc(s.address)}${s.city ? `<br>${esc(s.city)}` : ''}
      ${s.phone ? `<br>Ph: &nbsp;${esc(s.phone)}` : ''}
    </div>
    <div class="gst-cell">
      ${s.gstin ? `<span class="lbl">GST :</span>&nbsp; ${esc(s.gstin)}` : ''}
    </div>
  </div>

  <div class="date">DATE :${esc(billDate(p.paid_on))}</div>

  <div class="parties">
    <div>
      <h2>BILL TO</h2>
      <p>${esc(p.student_name)}<br>${esc(p.phone || '')}${p.reg_no ? `<br>${esc(p.reg_no)}` : ''}</p>
    </div>
    <div>
      <h2>FOR</h2>
      <p>${esc(p.course_name)}${p.batch_code ? `<br>${esc(batchLabel(p.batch_start, p.batch_code))}` : ''}</p>
    </div>
  </div>

  <table>
    <thead><tr>
      <th>Details</th><th class="mid">Course fees</th><th class="r">Paid</th>
    </tr></thead>
    <tbody>
      ${moneyRow(particulars, taxable, 'item')}
      <tr class="gap"><td colspan="3"></td></tr>
      ${taxPercent ? moneyRow(`TAX RATE ${taxPercent}%`, taxAmount, 'item') : ''}
      ${moneyRow('RoundOff', roundOff || null, 'item')}
      ${moneyRow('TOTAL', total, 'total')}
      ${paidTotal !== total ? moneyRow('Paid to date', paidTotal, 'item') : ''}
      ${balance > 0 ? moneyRow('Balance due', balance, 'item') : ''}
    </tbody>
  </table>

  <div class="words">In Words : ${esc(rupeesInWords(total))}</div>
  <div class="terms">${esc(s.terms)} Computer generated reciept.
    ${p.voided ? `<br><b style="color:#d63031">VOIDED: ${esc(p.void_reason)}</b>` : ''}</div>
  <div class="contact">If you have any questions concerning this invoice, use the following contact information:
    <br>${s.phone ? `Ph: ${esc(s.phone)}` : ''}${s.phone && s.email ? ', ' : ''}${esc(s.email || '')}</div>
  <div class="thanks">THANK YOU FOR LEARNING WITH US!</div>
</div></body></html>`;

  return { payment: p, html };
}

function paymentRow(id) {
  const p = db.get(
    `SELECT p.*, s.name AS student_name, s.reg_no, s.phone, s.email, s.address, s.city,
            c.name AS course_name, b.code AS batch_code, b.start_date AS batch_start
       FROM payments p
       JOIN students s ON s.id = p.student_id
       JOIN enrollments e ON e.id = p.enrollment_id
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN batches b ON b.id = e.batch_id
      WHERE p.id = ?`, [id],
  );
  if (!p) throw notFound('Payment not found');
  p.allocations = db.all(
    `SELECT a.*, i.label, i.due_date, i.sequence
       FROM payment_allocations a JOIN installments i ON i.id = a.installment_id
      WHERE a.payment_id = ? ORDER BY i.sequence`, [id],
  );
  return p;
}

/** Recompute an instalment's paid_amount/status from its allocations. */
function refreshInstallment(installmentId) {
  const i = db.get('SELECT * FROM installments WHERE id = ?', [installmentId]);
  if (!i) return;
  const paid = money(db.scalar(
    `SELECT COALESCE(SUM(a.amount),0) s FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id
      WHERE a.installment_id = ? AND p.voided = 0`, [installmentId],
  ));
  const status = i.status === 'Waived' ? 'Waived'
    : paid <= 0 ? 'Pending'
      : paid + 0.01 >= i.amount ? 'Paid' : 'Partial';
  db.run('UPDATE installments SET paid_amount = ?, status = ? WHERE id = ?', [paid, status, installmentId]);
}

/** Spread `amount` across open instalments, earliest due date first. */
function autoAllocate(enrollmentId, amount) {
  const open = db.all(
    `SELECT * FROM installments
      WHERE enrollment_id = ? AND status IN ('Pending','Partial')
      ORDER BY COALESCE(due_date,'9999-12-31'), sequence, id`, [enrollmentId],
  );
  const out = [];
  let left = money(amount);
  for (const i of open) {
    if (left <= 0) break;
    const due = money(i.amount - i.paid_amount);
    if (due <= 0) continue;
    const take = money(Math.min(due, left));
    out.push({ installment_id: i.id, amount: take });
    left = money(left - take);
  }
  return { allocations: out, unallocated: left };
}

module.exports = function register(router) {
  // -------------------------------------------------------------- list
  router.get('/api/payments', ({ query }) => {
    const where = [];
    const args = [];
    if (query.student_id) { where.push('p.student_id = ?'); args.push(query.student_id); }
    if (query.enrollment_id) { where.push('p.enrollment_id = ?'); args.push(query.enrollment_id); }
    if (query.mode) { where.push('p.mode = ?'); args.push(query.mode); }
    if (query.from) { where.push('p.paid_on >= ?'); args.push(toDate(query.from)); }
    if (query.to) { where.push('p.paid_on <= ?'); args.push(toDate(query.to)); }
    if (query.include_voided !== '1') where.push('p.voided = 0');
    if (query.q) {
      where.push('(p.receipt_no LIKE ? OR s.name LIKE ? OR s.reg_no LIKE ? OR p.reference LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like, like);
    }
    const rows = db.all(
      `SELECT p.*, s.name AS student_name, s.reg_no, s.email AS student_email, c.name AS course_name
         FROM payments p
         JOIN students s ON s.id = p.student_id
         JOIN enrollments e ON e.id = p.enrollment_id
         JOIN courses c ON c.id = e.course_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.paid_on DESC, p.id DESC LIMIT 500`,
      args,
    );
    const total = money(rows.filter((r) => !r.voided).reduce((s, r) => s + r.amount, 0));
    const byMode = {};
    for (const r of rows) if (!r.voided) byMode[r.mode] = money((byMode[r.mode] || 0) + r.amount);
    return { rows, total, by_mode: byMode, count: rows.length };
  });

  router.get('/api/payments/export', ({ query }) => {
    const args = [];
    let where = 'WHERE p.voided = 0';
    if (query.from) { where += ' AND p.paid_on >= ?'; args.push(toDate(query.from)); }
    if (query.to) { where += ' AND p.paid_on <= ?'; args.push(toDate(query.to)); }
    const rows = db.all(
      `SELECT p.receipt_no, p.paid_on, s.reg_no, s.name AS student, c.name AS course,
              p.amount, p.mode, p.reference, p.collected_by, p.remarks
         FROM payments p
         JOIN students s ON s.id = p.student_id
         JOIN enrollments e ON e.id = p.enrollment_id
         JOIN courses c ON c.id = e.course_id
        ${where} ORDER BY p.paid_on DESC`, args,
    );
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `dhishaai-payments-${today()}.csv`);
  });

  router.get('/api/payments/:id', ({ params }) => paymentRow(params.id));

  // ------------------------------------------------------------ record
  router.post('/api/payments', ({ user, body }) => {
    requireWrite(user, 'payments');
    required(body, ['enrollment_id', 'amount']);
    const amount = money(body.amount);
    if (amount <= 0) throw badRequest('Amount must be greater than zero', { amount: 'Enter an amount' });

    const e = db.get(
      `SELECT e.*, s.name AS student_name, s.reg_no FROM enrollments e
         JOIN students s ON s.id = e.student_id WHERE e.id = ?`, [body.enrollment_id],
    );
    if (!e) throw badRequest('Pick a valid enrollment', { enrollment_id: 'Not found' });

    const alreadyPaid = money(db.scalar(
      'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE enrollment_id = ? AND voided = 0',
      [body.enrollment_id],
    ));
    const balance = money(e.net_fee - alreadyPaid);
    if (amount > balance + 0.01 && !body.allow_overpay) {
      throw badRequest(
        `That is more than the ₹${balance.toLocaleString('en-IN')} outstanding on this enrollment. ` +
        'Check the amount, or resend with allow_overpay to record an advance.',
      );
    }

    return db.tx(() => {
      const receiptNo = str(body.receipt_no) || settings.nextReceiptNo();
      if (db.get('SELECT id FROM payments WHERE receipt_no = ?', [receiptNo])) {
        throw badRequest(`Receipt number ${receiptNo} already exists`);
      }
      const { lastInsertRowid: id } = db.run(
        `INSERT INTO payments (receipt_no, enrollment_id, student_id, amount, mode, reference,
                               paid_on, collected_by, remarks, voided, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
        [
          receiptNo, e.id, e.student_id, amount,
          oneOf(body.mode, C.PAYMENT_MODES, 'Cash'), str(body.reference),
          toDate(body.paid_on) || today(), str(body.collected_by) || user.name,
          str(body.remarks), nowIso(),
        ],
      );

      const plan = Array.isArray(body.allocations) && body.allocations.length
        ? { allocations: body.allocations.map((a) => ({ installment_id: a.installment_id, amount: money(a.amount) })), unallocated: 0 }
        : autoAllocate(e.id, amount);

      const allocSum = money(plan.allocations.reduce((s, a) => s + a.amount, 0));
      if (allocSum > amount + 0.01) throw badRequest('Allocations exceed the payment amount');

      for (const a of plan.allocations) {
        if (a.amount <= 0) continue;
        const inst = db.get('SELECT * FROM installments WHERE id = ? AND enrollment_id = ?',
          [a.installment_id, e.id]);
        if (!inst) throw badRequest(`Instalment ${a.installment_id} does not belong to this enrollment`);
        db.run(
          'INSERT INTO payment_allocations (payment_id, installment_id, amount) VALUES (?,?,?)',
          [id, a.installment_id, a.amount],
        );
        refreshInstallment(a.installment_id);
      }

      // Fully paid + still training? Nothing automatic — but flag it back to the UI.
      const nowPaid = money(alreadyPaid + amount);
      audit(user, 'payment', 'payments', id,
        `${receiptNo} — ${e.reg_no} ₹${amount} (${str(body.mode) || 'Cash'})`);

      const out = paymentRow(id);
      out.enrollment_balance = money(e.net_fee - nowPaid);
      out.unallocated = plan.unallocated;
      return out;
    });
  });

  // -------------------------------------------------------------- void
  router.post('/api/payments/:id/void', ({ user, params, body }) => {
    requireWrite(user, 'payments');
    required(body, ['reason']);
    const p = db.get('SELECT * FROM payments WHERE id = ?', [params.id]);
    if (!p) throw notFound('Payment not found');
    if (p.voided) throw badRequest('This receipt is already voided');

    return db.tx(() => {
      db.run('UPDATE payments SET voided = 1, void_reason = ? WHERE id = ?', [str(body.reason), params.id]);
      const touched = db.all('SELECT installment_id FROM payment_allocations WHERE payment_id = ?', [params.id]);
      for (const t of touched) refreshInstallment(t.installment_id);
      audit(user, 'update', 'payments', params.id, `voided ${p.receipt_no}: ${str(body.reason)}`);
      return paymentRow(params.id);
    });
  });

  // ------------------------------------------------------- re-allocate
  router.put('/api/payments/:id/allocations', ({ user, params, body }) => {
    requireWrite(user, 'payments');
    const p = db.get('SELECT * FROM payments WHERE id = ?', [params.id]);
    if (!p) throw notFound('Payment not found');
    if (p.voided) throw badRequest('A voided receipt cannot be re-allocated');
    if (!Array.isArray(body.allocations)) throw badRequest('Send an allocations array');

    const sum = money(body.allocations.reduce((s, a) => s + money(a.amount), 0));
    if (sum > p.amount + 0.01) throw badRequest(`Allocations (₹${sum}) exceed the receipt amount (₹${p.amount})`);

    return db.tx(() => {
      const previous = db.all('SELECT installment_id FROM payment_allocations WHERE payment_id = ?', [params.id]);
      db.run('DELETE FROM payment_allocations WHERE payment_id = ?', [params.id]);
      for (const a of body.allocations) {
        const amt = money(a.amount);
        if (amt <= 0) continue;
        const inst = db.get('SELECT * FROM installments WHERE id = ? AND enrollment_id = ?',
          [a.installment_id, p.enrollment_id]);
        if (!inst) throw badRequest(`Instalment ${a.installment_id} does not belong to this enrollment`);
        db.run('INSERT INTO payment_allocations (payment_id, installment_id, amount) VALUES (?,?,?)',
          [params.id, a.installment_id, amt]);
      }
      const ids = new Set([
        ...previous.map((x) => x.installment_id),
        ...body.allocations.map((x) => Number(x.installment_id)),
      ]);
      for (const i of ids) refreshInstallment(i);
      audit(user, 'update', 'payments', params.id, `re-allocated ${p.receipt_no}`);
      return paymentRow(params.id);
    });
  });

  // ----------------------------------------------------------- receipt
  router.get('/api/payments/:id/receipt', ({ params }) => {
    const { html } = receiptHtml(params.id);
    return raw(html, 'text/html; charset=utf-8');
  });

  // ------------------------------------------------- email the receipt
  /**
   * Send the bill to the address on the student's own record. Everything that
   * can be wrong — no address saved, no mail server configured — is reported
   * as a plain sentence, because whoever presses the button is the person who
   * has to fix it.
   */
  router.post('/api/payments/:id/email', async ({ user, params, body }) => {
    requireWrite(user, 'payments');
    const { html, payment: p } = receiptHtml(params.id, { embedLogo: true });

    const to = str(body.to) || str(p.email);
    if (!to) {
      throw badRequest(
        `${p.student_name} has no email address on their student record. `
        + 'Add one on their profile, then send the receipt.',
        { to: 'No email on file' },
      );
    }
    if (!isEmail(to)) throw badRequest(`"${to}" is not a valid email address`, { to: 'Invalid email' });
    if (!mailer.isConfigured()) {
      throw badRequest(
        'Email is not set up yet. Add your mail server details under Settings → Email, then try again.',
      );
    }

    const s = settings.all();
    const subject = `Fee receipt ${p.receipt_no} — ${s.institute_name}`;
    const text = [
      `Dear ${p.student_name},`,
      '',
      `Thank you for your payment of ${s.currency || '₹'}${money(p.amount).toLocaleString('en-IN')} `
      + `towards ${p.course_name}.`,
      `Receipt number: ${p.receipt_no}   Date: ${p.paid_on}`,
      '',
      'Your receipt is attached to this email.',
      '',
      s.terms || '',
      '',
      `${s.institute_name}${s.phone ? `, ${s.phone}` : ''}${s.email ? `, ${s.email}` : ''}`,
    ].join('\n');

    /*
     * A mail server refusing us is the user's problem to fix, not a crash:
     * without this the plain Error falls through to the 500 handler and the
     * screen says "Something went wrong on the server", hiding the one detail
     * that matters — which host, and why it would not talk to us.
     */
    try {
      await mailer.send({
        to,
        subject,
        text,
        html,
        attachments: [{
          filename: `${String(p.receipt_no).replace(/[^\w.-]+/g, '-')}.html`,
          contentType: 'text/html; charset=utf-8',
          content: html,
        }],
      });
    } catch (err) {
      throw badRequest(`${err.message} — check Settings → Email.`);
    }

    audit(user, 'update', 'payments', params.id, `receipt ${p.receipt_no} emailed to ${to}`);
    return { ok: true, to, receipt_no: p.receipt_no };
  });

  // ---------------------------------------------------- day collection
  router.get('/api/payments/summary/day', ({ query }) => {
    const d = toDate(query.date) || today();
    const rows = db.all(
      `SELECT p.*, s.name AS student_name, s.reg_no, c.name AS course_name
         FROM payments p
         JOIN students s ON s.id = p.student_id
         JOIN enrollments e ON e.id = p.enrollment_id
         JOIN courses c ON c.id = e.course_id
        WHERE p.paid_on = ? AND p.voided = 0
        ORDER BY p.id DESC`, [d],
    );
    const byMode = {};
    for (const r of rows) byMode[r.mode] = money((byMode[r.mode] || 0) + r.amount);
    return {
      date: d,
      rows,
      total: money(rows.reduce((s, r) => s + r.amount, 0)),
      by_mode: byMode,
    };
  });
};
