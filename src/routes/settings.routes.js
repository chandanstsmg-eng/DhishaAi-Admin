'use strict';
/** Institute settings, the shared enum payload, and JSON backup / restore. */

const { db } = require('../db');
const { requireRole, requireWrite, audit } = require('../auth');
const settings = require('../settings');
const mailer = require('../mailer');
const C = require('../constants');
const { str, today, badRequest, notFound, isEmail } = require('../util');
const { raw } = require('../router');

// Order matters on restore: parents before children.
const TABLES = [
  'settings', 'users', 'courses', 'course_modules', 'staff', 'batches',
  'students', 'student_documents', 'stage_history', 'enquiries', 'followups',
  'fee_plans', 'fee_plan_items', 'enrollments', 'installments',
  'payments', 'payment_allocations', 'expenses', 'attendance', 'placements', 'tasks',
];

module.exports = function register(router) {
  // ------------------------------------------------------------- meta
  /** Everything the browser needs to build dropdowns, in one call. */
  router.get('/api/meta', () => ({
    settings: settings.publicAll(),
    enums: {
      student_stages: C.STUDENT_STAGES,
      student_status: C.STUDENT_STATUS,
      enrollment_status: C.ENROLLMENT_STATUS,
      enquiry_status: C.ENQUIRY_STATUS,
      priority: C.PRIORITY,
      batch_status: C.BATCH_STATUS,
      modes: C.MODES,
      payment_modes: C.PAYMENT_MODES,
      installment_status: C.INSTALLMENT_STATUS,
      attendance_status: C.ATTENDANCE_STATUS,
      placement_status: C.PLACEMENT_STATUS,
      sources: C.SOURCES,
      channels: C.CHANNELS,
      designations: C.DESIGNATIONS,
      expense_categories: C.EXPENSE_CATEGORIES,
      doc_types: C.DOC_TYPES,
      roles: C.ROLES,
      days: C.DAYS,
    },
    lookups: {
      courses: db.all('SELECT id, code, name, base_fee, tax_percent FROM courses WHERE active = 1 ORDER BY name'),
      batches: db.all(
        `SELECT b.id, b.code, b.course_id, b.status, b.start_date, b.capacity,
                (SELECT COUNT(*) FROM enrollments e WHERE e.batch_id = b.id) AS filled
           FROM batches b WHERE b.status IN ('Planned','Ongoing') ORDER BY b.start_date DESC`),
      staff: db.all('SELECT id, name, designation FROM staff WHERE active = 1 ORDER BY name'),
      fee_plans: db.all(
        'SELECT id, course_id, name, total_fee, tax_percent FROM fee_plans WHERE active = 1 ORDER BY name'),
    },
    counts: {
      students: db.scalar('SELECT COUNT(*) c FROM students'),
      // the size of the register — the badge beside Enquiries, and the same
      // figure the screen itself reports
      enquiries_total: db.scalar('SELECT COUNT(*) c FROM enquiries'),
      /*
       * How many people someone is expected to ring: the promised date has
       * arrived or passed, or no call was ever booked. An enquiry nobody
       * scheduled is the easiest one to lose, so it belongs in the number
       * rather than out of it; a date still in the future is a promise not yet
       * due and is left out. Shared with the Follow-ups screen, so the badge
       * and the rows on that screen cannot disagree.
       */
      followups: db.scalar(C.CALLS_OWED_SQL),
      overdue: db.scalar(
        `SELECT COUNT(*) c FROM installments i JOIN enrollments e ON e.id = i.enrollment_id
          WHERE i.status IN ('Pending','Partial') AND i.due_date < date('now') AND e.status <> 'Dropped'`),
      tasks: db.scalar("SELECT COUNT(*) c FROM tasks WHERE status = 'Open'"),
    },
  }));

  // --------------------------------------------------------- settings
  router.get('/api/settings', () => settings.publicAll());

  router.put('/api/settings', ({ user, body }) => {
    requireRole(user, 'admin');
    /*
     * The commonest way to get email wrong is to put the address in the host
     * box. Caught here with the fix spelled out, rather than surfacing later
     * as a DNS failure nobody can read.
     */
    if (body.smtp_host !== undefined && str(body.smtp_host).includes('@')) {
      throw badRequest(
        'SMTP host is the mail server\'s name, not an email address. '
        + 'For Gmail use smtp.gmail.com and put the address in Username and Send from.',
        { smtp_host: 'Server name, e.g. smtp.gmail.com' },
      );
    }
    const allowed = Object.keys(settings.DEFAULTS);
    const changed = [];
    for (const key of allowed) {
      if (body[key] === undefined) continue;
      // the masked password is what was sent to the browser, not a new value
      if (settings.SECRET_KEYS.includes(key) && settings.isMask(body[key])) continue;
      settings.set(key, str(body[key]));
      changed.push(key);
    }
    if (!changed.length) throw badRequest('Nothing to update');
    audit(user, 'update', 'settings', null, changed.join(', '));
    return settings.publicAll();
  });

  // ------------------------------------------------------ demo outbox
  /** Everything demo mode has captured instead of sending. */
  router.get('/api/outbox', () => ({ mode: settings.get('mail_mode'), rows: mailer.outbox() }));

  /** One captured message, rendered as the recipient would see it. */
  router.get('/api/outbox/:id', ({ params }) => {
    const m = mailer.outboxItem(params.id);
    if (!m) throw notFound('That message is no longer in the outbox');
    const esc = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const page = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(m.subject)}</title>
<style>
 body{font:14px/1.6 "Segoe UI",Arial,sans-serif;margin:0;padding:26px;background:#f4f6f8;color:#12212e}
 .env{max-width:820px;margin:0 auto}
 .hdr{background:#fff;border:1px solid #e2e8ee;border-bottom:0;border-radius:6px 6px 0 0;padding:16px 20px}
 .hdr .row{display:flex;gap:10px;padding:2px 0;font-size:13.5px}
 .hdr .k{color:#64757f;min-width:64px}
 .hdr h1{margin:4px 0 10px;font-size:17px}
 .note{background:#fff8e6;border:1px solid #f0dca8;color:#7a5c00;font-size:12.5px;
       padding:9px 14px;border-radius:6px;margin-bottom:14px}
 .body{background:#fff;border:1px solid #e2e8ee;border-radius:0 0 6px 6px;padding:22px 20px}
</style></head><body><div class="env">
 <div class="note">Demo outbox — this message was captured, not delivered.
   Switch Settings → Email to a real mail server to send it for real.</div>
 <div class="hdr">
   <h1>${esc(m.subject)}</h1>
   <div class="row"><span class="k">From</span><span>${esc(m.from)}</span></div>
   <div class="row"><span class="k">To</span><span>${esc(m.to)}</span></div>
   <div class="row"><span class="k">Sent</span><span>${esc(m.sent_at)}</span></div>
   ${(m.attachments || []).map((a) => `<div class="row"><span class="k">Attached</span><span>${esc(a.filename)}</span></div>`).join('')}
 </div>
 <div class="body">${m.html || `<pre>${esc(m.text)}</pre>`}</div>
</div></body></html>`;
    return raw(page, 'text/html; charset=utf-8');
  });

  router.del('/api/outbox', ({ user }) => {
    requireRole(user, 'admin');
    return { cleared: mailer.clearOutbox() };
  });

  /** Prove the mail settings work before relying on them for a real receipt. */
  router.post('/api/settings/email-test', async ({ user, body }) => {
    requireRole(user, 'admin');
    const to = str(body.to);
    if (!to || !isEmail(to)) throw badRequest('Enter an address to send the test to', { to: 'Invalid email' });
    if (!mailer.isConfigured()) {
      throw badRequest('Fill in the mail server host and the "send from" address first.');
    }
    const s = settings.all();
    // the whole point of a test is to be told exactly what failed
    try {
      await mailer.send({
        to,
        subject: `Test email from ${s.institute_name}`,
        text: 'If you are reading this, the admin portal can send email. Nothing else to do.',
        html: '<p>If you are reading this, the admin portal can send email. Nothing else to do.</p>',
      });
    } catch (err) {
      throw badRequest(err.message);
    }
    audit(user, 'update', 'settings', null, `email test sent to ${to}`);
    return { ok: true, to };
  });

  // ----------------------------------------------------------- backup
  router.get('/api/backup', ({ user }) => {
    requireRole(user, 'admin');
    const dump = { exported_at: new Date().toISOString(), version: 1, tables: {} };
    for (const t of TABLES) dump.tables[t] = db.all(`SELECT * FROM ${t}`);
    audit(user, 'create', 'backup', null, `${TABLES.length} tables`);
    return raw(
      JSON.stringify(dump, null, 2),
      'application/json; charset=utf-8',
      `dhishaai-backup-${today()}.json`,
    );
  });

  router.post('/api/restore', ({ user, body }) => {
    requireRole(user, 'owner');
    if (body.confirm !== 'REPLACE ALL DATA') {
      throw badRequest('Restoring replaces every record. Send confirm: "REPLACE ALL DATA" to proceed.');
    }
    const dump = body.dump;
    if (!dump || !dump.tables) throw badRequest('That file is not a Dhishaai backup');

    return db.tx(() => {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        for (const t of [...TABLES].reverse()) db.run(`DELETE FROM ${t}`);
        let restored = 0;
        for (const t of TABLES) {
          const rows = dump.tables[t];
          if (!Array.isArray(rows) || !rows.length) continue;
          for (const row of rows) {
            const keys = Object.keys(row);
            db.run(
              `INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
              keys.map((k) => row[k]),
            );
            restored++;
          }
        }
        audit(user, 'update', 'restore', null, `${restored} rows restored`);
        return { ok: true, restored };
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    });
  });

  /** Wipe transactional data but keep the catalogue — useful after piloting. */
  router.post('/api/settings/clear-demo', ({ user, body }) => {
    requireRole(user, 'owner');
    if (body.confirm !== 'CLEAR DEMO DATA') {
      throw badRequest('Send confirm: "CLEAR DEMO DATA" to proceed.');
    }
    return db.tx(() => {
      for (const t of [
        'payment_allocations', 'payments', 'installments', 'enrollments',
        'attendance', 'placements', 'stage_history', 'student_documents',
        'students', 'followups', 'enquiries', 'expenses', 'tasks',
      ]) db.run(`DELETE FROM ${t}`);
      audit(user, 'delete', 'settings', null, 'demo data cleared');
      return { ok: true };
    });
  });

  /** Table row counts — shown on the Settings screen. */
  router.get('/api/settings/stats', ({ user }) => {
    requireRole(user, 'admin');
    const out = {};
    for (const t of TABLES) out[t] = db.scalar(`SELECT COUNT(*) c FROM ${t}`);
    return { tables: out, database: require('../db').DB_FILE, driver: db.flavour };
  });
};
