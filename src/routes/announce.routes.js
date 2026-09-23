'use strict';
/**
 * Telling a batch something — chiefly the day their classes begin.
 *
 * Enrolling a student already sends them a welcome, but that goes out the
 * moment they pay, often weeks before anyone knows which morning to turn up on.
 * This is the second message: written once for a batch, addressed to each
 * student by name, and sent when the date is actually settled.
 *
 * Deliberately manual. Nothing here fires on its own — an announcement that
 * sends itself is an announcement nobody checked, and the whole point is that
 * the office says when.
 */

const { db } = require('../db');
const { requireRole, audit } = require('../auth');
const settings = require('../settings');
const mailer = require('../mailer');
const { str, badRequest, notFound, batchLabel } = require('../util');

const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * "Monday, 17 August 2026" — spelled out, because a class start date is read
 * once and acted on. 17/08 could be August or the 8th of a month in the wrong
 * hands, and the weekday is what a student actually plans around.
 *
 * Built by hand from the parts rather than by Date formatting: a date-only
 * string parsed as UTC and printed in IST comes out a day early, which on this
 * message is the one mistake that cannot be shrugged off.
 */
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
  if (!m) return str(iso);
  const [, y, mo, d] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(at.getTime())) return str(iso);
  return `${DAYS_LONG[at.getDay()]}, ${Number(d)} ${MONTHS_LONG[Number(mo) - 1]} ${y}`;
}

function batchRow(id) {
  const b = db.get(
    `SELECT b.id, b.code, b.start_date, b.end_date, b.time_slot, b.mode, b.status,
            c.name AS course_name, s.name AS trainer_name
       FROM batches b
       JOIN courses c ON c.id = b.course_id
       LEFT JOIN staff s ON s.id = b.trainer_id
      WHERE b.id = ?`, [id],
  );
  if (!b) throw notFound('Batch not found');
  return b;
}

/**
 * Who is in the batch. A dropped enrollment is not told when class starts, but
 * everyone else is listed — including students with no email address, so the
 * screen can say who will be missed instead of quietly sending to fewer people
 * than the office thinks.
 */
function recipients(batchId) {
  return db.all(
    `SELECT s.id AS student_id, s.name, s.reg_no, s.email, s.phone,
            e.id AS enrollment_id, e.status AS enrollment_status
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
      WHERE e.batch_id = ? AND e.status <> 'Dropped'
      ORDER BY s.name`, [batchId],
  );
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Substitute the placeholders, then drop any line left saying nothing.
 *
 * A batch with no timing recorded would otherwise send "Timings:" followed by
 * white space, which reads like the information was lost rather than never
 * given. A label with an empty value is removed whole.
 */
function fillTemplate(text, vars) {
  const filled = String(text || '').replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole
  ));
  return filled
    .split('\n')
    .filter((line) => !/^\s*[A-Za-z][A-Za-z ]*:\s*$/.test(line))
    .join('\n');
}

function varsFor(student, batch, startDate, institute) {
  return {
    name: student.name,
    course: batch.course_name,
    batch: batchLabel(batch.start_date, batch.code) || 'your batch',
    start_date: longDate(startDate),
    time: str(batch.time_slot),
    trainer: str(batch.trainer_name),
    mode: str(batch.mode),
    institute,
  };
}

module.exports = function register(router) {
  /** The batch, who would be written to, and the wording last saved. */
  router.get('/api/announcements/recipients', ({ user, query }) => {
    requireRole(user, 'admin');
    const batch = batchRow(Number(query.batch_id));
    const rows = recipients(batch.id);
    const s = settings.all();
    return {
      batch,
      rows,
      with_email: rows.filter((r) => str(r.email)).length,
      without_email: rows.filter((r) => !str(r.email)).length,
      template: {
        subject: s.class_start_subject || settings.DEFAULTS.class_start_subject,
        message: s.class_start_message || settings.DEFAULTS.class_start_message,
      },
      mail_mode: s.mail_mode === 'demo' ? 'demo' : 'smtp',
      mail_ready: mailer.isConfigured(),
    };
  });

  /**
   * Send it. `preview: 1` fills the template for the first recipient and stops
   * there — the same code path, so what is shown is what would go out rather
   * than a second rendering that can drift from the first.
   */
  router.post('/api/announcements/class-start', async ({ user, body }) => {
    requireRole(user, 'admin');
    const batch = batchRow(Number(body.batch_id));
    const startDate = str(body.start_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw badRequest('Pick the date the classes start', { start_date: 'Required' });
    }
    const subject = str(body.subject);
    const message = str(body.message);
    if (!subject) throw badRequest('The message needs a subject', { subject: 'Required' });
    if (!message) throw badRequest('There is nothing to send', { message: 'Required' });

    const s = settings.all();
    const chosen = Array.isArray(body.student_ids) && body.student_ids.length
      ? new Set(body.student_ids.map(Number))
      : null;
    const all = recipients(batch.id);
    const picked = chosen ? all.filter((r) => chosen.has(r.student_id)) : all;
    const skipped = picked.filter((r) => !str(r.email));
    const sendable = picked.filter((r) => str(r.email));

    if (body.preview) {
      const who = sendable[0] || picked[0];
      if (!who) throw badRequest('Nobody is enrolled in this batch yet');
      const vars = varsFor(who, batch, startDate, s.institute_name);
      return {
        preview: {
          to: str(who.email) || `${who.name} — no email address on record`,
          subject: fillTemplate(subject, vars),
          text: fillTemplate(message, vars),
        },
        recipients: sendable.length,
        skipped: skipped.length,
      };
    }

    if (!sendable.length) {
      throw badRequest(skipped.length
        ? 'Not one of the students you picked has an email address on their record.'
        : 'Pick at least one student to write to.');
    }
    if (!mailer.isConfigured()) {
      throw badRequest('Email is not set up yet — see Settings → Institute → Email.');
    }

    /*
     * The date the students are told and the date the portal holds must not
     * disagree — but changing a batch is the admin's decision, not a side
     * effect of writing to people, so it happens only when asked for.
     *
     * Done before a single message leaves: if this is going to fail it must
     * fail while the announcement can still be corrected, not after forty
     * students have already been told.
     */
    let batchUpdated = false;
    if (body.update_batch && startDate !== batch.start_date) {
      db.run('UPDATE batches SET start_date = ? WHERE id = ?', [startDate, batch.id]);
      audit(user, 'update', 'batch', batch.id, `start date ${batch.start_date} → ${startDate}`);
      batchUpdated = true;
    }

    /*
     * One at a time, and one student's failure is not another's. The mailer
     * opens a connection per message, so a refused address, a typo or a
     * mid-way disconnection stops that student's mail and nothing else; the
     * reply says exactly who was reached and who was not.
     */
    const results = [];
    for (const r of sendable) {
      const vars = varsFor(r, batch, startDate, s.institute_name);
      const text = fillTemplate(message, vars);
      const html = `<div style="font:14px/1.65 Segoe UI,Arial,sans-serif;color:#1b1b1b">${
        text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
      }</div>`;
      try {
        await mailer.send({ to: r.email, subject: fillTemplate(subject, vars), text, html });
        results.push({ student_id: r.student_id, name: r.name, email: r.email, ok: true });
      } catch (err) {
        results.push({ student_id: r.student_id, name: r.name, email: r.email, ok: false, reason: err.message });
      }
    }
    for (const r of skipped) {
      results.push({
        student_id: r.student_id, name: r.name, email: '', ok: false,
        reason: 'No email address on their student record',
      });
    }

    if (body.save_template) {
      settings.set('class_start_subject', subject);
      settings.set('class_start_message', message);
    }

    const sent = results.filter((r) => r.ok).length;
    audit(user, 'create', 'announcement', batch.id,
      `class start ${startDate} announced to ${sent} student(s) in ${batch.code}`);

    return {
      ok: true,
      batch: batch.code,
      start_date: startDate,
      sent,
      failed: results.filter((r) => !r.ok && r.email).length,
      skipped: skipped.length,
      batch_updated: batchUpdated,
      demo: s.mail_mode === 'demo',
      results,
    };
  });
};
