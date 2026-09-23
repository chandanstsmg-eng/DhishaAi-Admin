'use strict';
/**
 * Enrollments — the join between a student, a course, a batch and a fee
 * schedule. Creating one snapshots the fee plan into concrete `installments`
 * so later edits to the plan template never disturb an issued schedule.
 */

const { db } = require('../db');
const { requireWrite, audit } = require('../auth');
const settings = require('../settings');
const { ensureCourse } = require('../courses');
const mailer = require('../mailer');
const C = require('../constants');
const {
  required, str, money, nowIso, today, toDate, addDays, notFound, badRequest,
  conflict, oneOf, toCsv, batchLabel,
} = require('../util');
const { raw } = require('../router');

function enrollmentRow(id) {
  const e = db.get(
    `SELECT e.*, c.name AS course_name, c.code AS course_code,
            b.code AS batch_code, b.start_date AS batch_start,
            s.name AS student_name, s.reg_no, s.phone, s.email,
            f.name AS fee_plan_name,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.enrollment_id = e.id AND p.voided = 0), 0) AS paid
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN batches b ON b.id = e.batch_id
       LEFT JOIN fee_plans f ON f.id = e.fee_plan_id
      WHERE e.id = ?`, [id],
  );
  if (!e) throw notFound('Enrollment not found');
  e.balance = money(e.net_fee - e.paid);
  e.installments = db.all(
    'SELECT * FROM installments WHERE enrollment_id = ? ORDER BY sequence, id', [id],
  );
  e.payments = db.all(
    'SELECT * FROM payments WHERE enrollment_id = ? ORDER BY paid_on DESC, id DESC', [id],
  );
  return e;
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Welcome a newly enrolled student by email.
 *
 * Never throws: the enrollment is already committed when this runs, and a mail
 * server being down is not a reason to lose it. The wording lives in settings
 * so the office can change it without a code change; {name}, {course} and
 * {batch} are filled in where they appear.
 */
async function sendWelcome(enrollment, student, course) {
  const s = settings.all();
  if (s.enroll_welcome_enabled !== '1') return { sent: false, reason: 'Welcome emails are switched off' };
  if (!student.email) {
    return { sent: false, reason: `${student.name} has no email address on their student record` };
  }
  if (!mailer.isConfigured()) {
    return { sent: false, reason: 'Email is not set up under Settings → Email' };
  }

  const fill = (t) => String(t || '')
    .replace(/\{name\}/g, student.name)
    .replace(/\{course\}/g, course.name)
    .replace(/\{batch\}/g, batchLabel(enrollment.batch_start, enrollment.batch_code) || 'your batch')
    .replace(/\{institute\}/g, s.institute_name);

  const body = fill(s.enroll_welcome_message || settings.DEFAULTS.enroll_welcome_message);
  const html = `<div style="font:14px/1.65 Segoe UI,Arial,sans-serif;color:#1b1b1b">${
    body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
  }</div>`;

  try {
    await mailer.send({
      to: student.email,
      subject: fill(s.enroll_welcome_subject || settings.DEFAULTS.enroll_welcome_subject),
      text: body,
      html,
    });
    return { sent: true, to: student.email };
  } catch (err) {
    return { sent: false, to: student.email, reason: err.message };
  }
}

/** gross − discount + tax  →  { gross, discount, tax_percent, tax_amount, net } */
function priceOut(body, course, plan) {
  const gross = body.gross_fee !== undefined
    ? money(body.gross_fee)
    : money(plan ? plan.total_fee : (course ? course.base_fee : 0));
  const discount = money(body.discount);
  if (discount < 0) throw badRequest('Discount cannot be negative', { discount: 'Invalid' });
  if (discount > gross) throw badRequest('Discount cannot exceed the course fee', { discount: 'Too high' });

  /*
   * GST belongs to the course — it is a property of what is being sold, not of
   * the schedule it is paid on. So the course's rate is what a fee plan
   * inherits, and a plan only speaks for itself when the enrollment has no
   * course rate to go by. A rate of 0 means genuinely zero-rated; only a
   * missing rate falls through to the institute default.
   */
  const inherited = course && course.tax_percent != null ? course.tax_percent
    : (plan && plan.tax_percent != null ? plan.tax_percent : null);
  const taxPercent = body.tax_percent !== undefined
    ? money(body.tax_percent)
    : money(inherited != null ? inherited : settings.get('default_tax_percent'));
  const taxable = money(gross - discount);
  const taxAmount = money((taxable * taxPercent) / 100);
  return { gross, discount, taxPercent, taxAmount, net: money(taxable + taxAmount) };
}

/**
 * Write the instalment schedule for an enrollment. Plan-item amounts are
 * scaled proportionally so the schedule always sums to exactly `net`.
 */
function generateInstallments(enrollmentId, net, planId, startDate, customItems) {
  db.run('DELETE FROM installments WHERE enrollment_id = ?', [enrollmentId]);

  let items;
  if (Array.isArray(customItems) && customItems.length) {
    items = customItems.map((it, i) => ({
      sequence: i + 1,
      label: str(it.label) || `Instalment ${i + 1}`,
      amount: money(it.amount),
      due_date: toDate(it.due_date) || addDays(startDate, Number(it.due_offset_days) || 0),
    }));
  } else {
    const planItems = planId
      ? db.all('SELECT * FROM fee_plan_items WHERE fee_plan_id = ? ORDER BY sequence, id', [planId])
      : [];
    if (!planItems.length) {
      items = [{ sequence: 1, label: 'Full payment', amount: net, due_date: startDate }];
    } else {
      const planTotal = money(planItems.reduce((s, i) => s + i.amount, 0)) || 1;
      let running = 0;
      items = planItems.map((it, idx) => {
        const isLast = idx === planItems.length - 1;
        const amount = isLast ? money(net - running) : money((it.amount / planTotal) * net);
        running = money(running + amount);
        return {
          sequence: it.sequence || idx + 1,
          label: it.label,
          amount,
          due_date: addDays(startDate, it.due_offset_days),
        };
      });
    }
  }

  const sum = money(items.reduce((s, i) => s + i.amount, 0));
  if (Math.abs(sum - net) > 0.01) {
    throw badRequest(`Instalments total ₹${sum} but the payable fee is ₹${net}.`);
  }
  for (const it of items) {
    db.run(
      `INSERT INTO installments (enrollment_id, sequence, label, amount, paid_amount, due_date, status)
       VALUES (?,?,?,?,0,?,'Pending')`,
      [enrollmentId, it.sequence, it.label, it.amount, it.due_date],
    );
  }
}

module.exports = function register(router) {
  router.get('/api/enrollments', ({ query }) => {
    const where = [];
    const args = [];
    if (query.student_id) { where.push('e.student_id = ?'); args.push(query.student_id); }
    if (query.course_id) { where.push('e.course_id = ?'); args.push(query.course_id); }
    if (query.batch_id) { where.push('e.batch_id = ?'); args.push(query.batch_id); }
    if (query.status) { where.push('e.status = ?'); args.push(query.status); }
    if (query.unassigned === '1') where.push('e.batch_id IS NULL');
    if (query.q) {
      where.push('(s.name LIKE ? OR s.reg_no LIKE ? OR s.phone LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like);
    }
    /*
     * Enrolled-date range. Both ends are inclusive, hence date() on either
     * side — a bare string compare would drop the "to" day itself.
     */
    if (query.from) { where.push('date(e.enrolled_on) >= date(?)'); args.push(query.from); }
    if (query.to) { where.push('date(e.enrolled_on) <= date(?)'); args.push(query.to); }
    const rows = db.all(
      `SELECT e.*, s.name AS student_name, s.reg_no, s.phone,
              c.name AS course_name, b.code AS batch_code, b.start_date AS batch_start,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         WHERE p.enrollment_id = e.id AND p.voided = 0), 0) AS paid
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN batches b ON b.id = e.batch_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.enrolled_on DESC, e.id DESC`,
      args,
    );
    for (const r of rows) r.balance = money(r.net_fee - r.paid);
    return { rows, total: rows.length };
  });

  router.get('/api/enrollments/export', ({ query }) => {
    // the download honours the enrolled-date range on screen, so what lands in
    // the CSV matches what was being looked at
    const where = [];
    const args = [];
    if (query.from) { where.push('date(e.enrolled_on) >= date(?)'); args.push(query.from); }
    if (query.to) { where.push('date(e.enrolled_on) <= date(?)'); args.push(query.to); }
    const rows = db.all(
      `SELECT s.reg_no, s.name AS student, c.name AS course, b.code AS batch,
              e.enrolled_on, e.gross_fee, e.discount, e.tax_amount, e.net_fee,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         WHERE p.enrollment_id = e.id AND p.voided = 0), 0) AS paid,
              e.status
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN batches b ON b.id = e.batch_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.enrolled_on DESC`,
      args,
    );
    for (const r of rows) r.balance = money(r.net_fee - r.paid);
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `dhishaai-enrollments-${today()}.csv`);
  });

  router.get('/api/enrollments/:id', ({ params }) => enrollmentRow(params.id));

  // ------------------------------------------------------------ create
  router.post('/api/enrollments', async ({ user, body }) => {
    requireWrite(user, 'enrollments');
    required(body, ['student_id']);
    /*
     * Either a course picked from the list or one written in because we do not
     * run it yet. Unlike an enquiry there is nowhere here to keep loose text:
     * enrollments.course_id is NOT NULL, and the batch, the fee plan and every
     * instalment hang off a real course row. So a write-in becomes a course, and
     * the enrollment is made against that.
     */
    const writeIn = body.course_id ? '' : str(body.course_other);
    if (!body.course_id && !writeIn) {
      throw badRequest('Pick a course, or type one under "Other"', { course_id: 'Required' });
    }

    const student = db.get('SELECT * FROM students WHERE id = ?', [body.student_id]);
    if (!student) throw badRequest('Pick a valid student', { student_id: 'Required' });

    let course = null;
    if (body.course_id) {
      course = db.get('SELECT * FROM courses WHERE id = ?', [body.course_id]);
      if (!course) throw badRequest('Pick a valid course', { course_id: 'Required' });
    }

    let batch = null;
    if (body.batch_id) {
      batch = db.get('SELECT * FROM batches WHERE id = ?', [body.batch_id]);
      if (!batch) throw badRequest('Pick a valid batch', { batch_id: 'Not found' });
      if (Number(batch.course_id) !== Number(body.course_id)) {
        throw badRequest(`That batch belongs to a different course.`, { batch_id: 'Wrong course' });
      }
      const filled = db.scalar('SELECT COUNT(*) c FROM enrollments WHERE batch_id = ?', [batch.id]);
      if (filled >= batch.capacity && !body.allow_overbook) {
        throw badRequest(
          `Batch ${batch.code} is full (${filled}/${batch.capacity}). ` +
          'Raise the capacity or resend with allow_overbook.',
        );
      }
    }

    let plan = null;
    if (body.fee_plan_id) {
      plan = db.get('SELECT * FROM fee_plans WHERE id = ?', [body.fee_plan_id]);
      if (!plan) throw badRequest('Pick a valid fee plan', { fee_plan_id: 'Not found' });
      if (Number(plan.course_id) !== Number(body.course_id)) {
        throw badRequest('That fee plan belongs to a different course.', { fee_plan_id: 'Wrong course' });
      }
    }

    /*
     * The write-in becomes a course only once everything else has passed, so a
     * form rejected for some other reason does not leave a course behind that
     * nobody enrolled in. It carries the fee and GST rate typed on this very
     * form as its defaults — this form knows them, and they are exactly what
     * the Courses screen would otherwise have to be told separately.
     */
    let courseAdded = null;
    if (writeIn) {
      courseAdded = ensureCourse(user, writeIn, {
        baseFee: body.gross_fee,
        taxPercent: body.tax_percent,
        note: 'Added while enrolling a student — duration and modules still to be filled in.',
      });
      course = db.get('SELECT * FROM courses WHERE id = ?', [courseAdded.id]);
    }
    const courseId = course.id;

    /*
     * Checked here rather than earlier because a name typed under Other can
     * turn out to be a course we already run — and the student may already be
     * on it. Deciding before the name was resolved would have missed that.
     */
    const existing = db.get(
      "SELECT id FROM enrollments WHERE student_id = ? AND course_id = ? AND status = 'Active'",
      [body.student_id, courseId],
    );
    if (existing && !body.allow_duplicate) {
      throw conflict(`${student.name} already has an active enrollment in ${course.name}.`);
    }

    const price = priceOut(body, course, plan);
    const enrolledOn = toDate(body.enrolled_on) || today();

    const created = db.tx(() => {
      const { lastInsertRowid: id } = db.run(
        `INSERT INTO enrollments (student_id, course_id, batch_id, fee_plan_id, gross_fee, discount,
                                  discount_note, tax_percent, tax_amount, net_fee, status,
                                  enrolled_on, remarks, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          body.student_id, courseId, body.batch_id || null, body.fee_plan_id || null,
          price.gross, price.discount, str(body.discount_note),
          price.taxPercent, price.taxAmount, price.net,
          oneOf(body.status, C.ENROLLMENT_STATUS, 'Active'),
          enrolledOn, str(body.remarks), nowIso(),
        ],
      );
      generateInstallments(
        id, price.net, body.fee_plan_id || null,
        toDate(body.schedule_from) || (batch && batch.start_date) || enrolledOn,
        body.installments,
      );
      /*
       * Enrolling used to nudge a student from "Admitted" to "Documents
       * Pending". Both stages are gone, and a student now starts in Training,
       * so there is nothing left for an enrollment to advance — it would only
       * be moving someone off a stage they were deliberately put on.
       */
      audit(user, 'create', 'enrollments', id,
        `${student.reg_no} → ${course.name} (₹${price.net})`);
      return enrollmentRow(id);
    });

    // The enrollment is committed; the welcome note is a separate thing that
    // may fail on its own, and says so rather than taking the enrollment down.
    created.welcome = await sendWelcome(created, student, course);
    // so the screen can say a course joined the list, and refresh its lookups
    created.course_added = courseAdded;
    return created;
  });

  // ------------------------------------------------------------ update
  router.put('/api/enrollments/:id', ({ user, params, body }) => {
    requireWrite(user, 'enrollments');
    const e = db.get('SELECT * FROM enrollments WHERE id = ?', [params.id]);
    if (!e) throw notFound('Enrollment not found');

    const paid = db.scalar(
      'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE enrollment_id = ? AND voided = 0', [params.id],
    );

    /*
     * Student, course, plan and joining date are all editable — a wrong one
     * has to be fixable. What is not negotiable is the money: payments are
     * allocated to instalment rows, and payment_allocations cascades when an
     * instalment is deleted, so rebuilding a schedule under a paid enrollment
     * would erase where that money went. Hence the guards below rather than a
     * flat refusal: the change goes through, the audit trail survives.
     */
    const notes = [];

    // ---- student: the enrollment and its receipts move together
    let studentId = e.student_id;
    if (body.student_id !== undefined && Number(body.student_id) !== Number(e.student_id)) {
      const target = db.get('SELECT * FROM students WHERE id = ?', [body.student_id]);
      if (!target) throw badRequest('Pick a valid student', { student_id: 'Not found' });
      studentId = target.id;
      notes.push(`moved to ${target.name} (${target.reg_no})`);
    }

    // ---- course: a batch belonging to the old course can no longer apply
    let courseId = e.course_id;
    if (body.course_id !== undefined && Number(body.course_id) !== Number(e.course_id)) {
      const target = db.get('SELECT * FROM courses WHERE id = ?', [body.course_id]);
      if (!target) throw badRequest('Pick a valid course', { course_id: 'Not found' });
      courseId = target.id;
      notes.push(`course changed to ${target.name}`);
    }

    let batchId = body.batch_id === undefined ? e.batch_id : (body.batch_id || null);
    if (batchId) {
      const batch = db.get('SELECT * FROM batches WHERE id = ?', [batchId]);
      if (!batch) throw badRequest('Pick a valid batch', { batch_id: 'Not found' });
      if (Number(batch.course_id) !== Number(courseId)) {
        // the course moved out from under the batch — drop it rather than
        // leave a student sitting in another course's classroom
        if (Number(courseId) !== Number(e.course_id)) {
          batchId = null;
          notes.push('batch cleared — it belongs to the previous course');
        } else {
          throw badRequest('That batch belongs to a different course.', { batch_id: 'Wrong course' });
        }
      } else if (Number(batchId) !== Number(e.batch_id)) {
        const filled = db.scalar('SELECT COUNT(*) c FROM enrollments WHERE batch_id = ?', [batchId]);
        if (filled >= batch.capacity && !body.allow_overbook) {
          throw badRequest(`Batch ${batch.code} is full (${filled}/${batch.capacity}).`);
        }
      }
    }

    // ---- fee plan: only rebuildable while no money has landed on it
    let planId = body.fee_plan_id === undefined ? e.fee_plan_id : (body.fee_plan_id || null);
    let rebuildSchedule = false;
    if (Number(planId || 0) !== Number(e.fee_plan_id || 0)) {
      if (planId) {
        const target = db.get('SELECT * FROM fee_plans WHERE id = ?', [planId]);
        if (!target) throw badRequest('Pick a valid fee plan', { fee_plan_id: 'Not found' });
        if (Number(target.course_id) !== Number(courseId)) {
          throw badRequest('That fee plan belongs to a different course.', { fee_plan_id: 'Wrong course' });
        }
      }
      if (paid > 0) {
        notes.push('fee plan noted, but the schedule was kept — money is already allocated against it');
      } else {
        rebuildSchedule = true;
        notes.push('instalment schedule rebuilt from the new plan');
      }
    }

    /*
     * A schedule sent outright — the count and the due dates set on the
     * enrollment form — rebuilds on exactly the same terms as a plan change.
     * Once money has landed the rows own allocations, and rewriting them would
     * erase where that money went, so the change is reported and refused
     * rather than done quietly.
     */
    const customItems = Array.isArray(body.installments) && body.installments.length
      ? body.installments : null;
    if (customItems) {
      if (paid === 0) rebuildSchedule = true;
      else {
        /*
         * Compared rather than assumed: the form sends its schedule on every
         * save, so warning whenever one arrives would put a notice on an edit
         * that only changed a remark. The notice is for a schedule that really
         * would have changed and could not.
         */
        const current = db.all(
          'SELECT sequence, amount, due_date FROM installments WHERE enrollment_id = ? ORDER BY sequence',
          [params.id],
        );
        const same = current.length === customItems.length && current.every((it, i) => {
          const sent = customItems[i];
          return String(it.due_date || '').slice(0, 10) === String(sent.due_date || '').slice(0, 10)
            && Math.abs(Number(it.amount) - Number(sent.amount)) < 0.01;
        });
        if (!same) notes.push('instalment schedule kept — money is already allocated against it');
      }
    }

    const enrolledOn = body.enrolled_on === undefined
      ? e.enrolled_on
      : (toDate(body.enrolled_on) || e.enrolled_on);

    const course = db.get('SELECT * FROM courses WHERE id = ?', [courseId]);
    const plan = planId ? db.get('SELECT * FROM fee_plans WHERE id = ?', [planId]) : null;
    const wantsRepricing = ['gross_fee', 'discount', 'tax_percent'].some((k) => body[k] !== undefined);
    const price = wantsRepricing
      ? priceOut({ ...e, ...body }, course, plan)
      : { gross: e.gross_fee, discount: e.discount, taxPercent: e.tax_percent, taxAmount: e.tax_amount, net: e.net_fee };

    if (wantsRepricing && price.net < paid) {
      throw badRequest(
        `₹${money(paid)} has already been collected; the payable fee cannot be reduced to ₹${price.net}.`,
      );
    }

    const status = oneOf(body.status, C.ENROLLMENT_STATUS, e.status);

    return db.tx(() => {
      db.run(
        `UPDATE enrollments SET student_id=?, course_id=?, batch_id=?, fee_plan_id=?, enrolled_on=?,
                status=?, gross_fee=?, discount=?, discount_note=?,
                tax_percent=?, tax_amount=?, net_fee=?, remarks=?, completed_on=?, certificate_no=?
          WHERE id=?`,
        [
          studentId, courseId, batchId, planId, enrolledOn,
          status, price.gross, price.discount,
          body.discount_note === undefined ? e.discount_note : str(body.discount_note),
          price.taxPercent, price.taxAmount, price.net,
          body.remarks === undefined ? e.remarks : str(body.remarks),
          status === 'Completed' ? (toDate(body.completed_on) || e.completed_on || today()) : e.completed_on,
          body.certificate_no === undefined ? e.certificate_no : str(body.certificate_no),
          params.id,
        ],
      );

      // receipts follow the enrollment, or the money would sit under the wrong name
      if (Number(studentId) !== Number(e.student_id)) {
        db.run('UPDATE payments SET student_id = ? WHERE enrollment_id = ?', [studentId, params.id]);
      }

      // safe only because this branch is reached solely when nothing is paid
      if (rebuildSchedule) {
        generateInstallments(params.id, price.net, planId, enrolledOn, customItems);
      }

      // Repricing rebuilds only the still-unpaid tail of the schedule.
      if (!rebuildSchedule && wantsRepricing && Math.abs(price.net - e.net_fee) > 0.01) {
        const untouched = db.all(
          `SELECT * FROM installments WHERE enrollment_id = ? AND paid_amount = 0 AND status = 'Pending'
            ORDER BY sequence`, [params.id],
        );
        const lockedTotal = money(
          db.scalar(
            `SELECT COALESCE(SUM(amount),0) s FROM installments
              WHERE enrollment_id = ? AND (paid_amount > 0 OR status IN ('Paid','Waived'))`, [params.id],
          ),
        );
        const remaining = money(price.net - lockedTotal);
        if (untouched.length && remaining >= 0) {
          const each = money(remaining / untouched.length);
          untouched.forEach((it, i) => {
            const amt = i === untouched.length - 1 ? money(remaining - each * (untouched.length - 1)) : each;
            db.run('UPDATE installments SET amount = ? WHERE id = ?', [amt, it.id]);
          });
        }
      }
      audit(user, 'update', 'enrollments', params.id,
        [`status=${status}`, `net=₹${price.net}`, ...notes].join('; '));
      const out = enrollmentRow(params.id);
      // what the save quietly did, so the screen can say it out loud
      out.notes = notes;
      return out;
    });
  });

  /** Replace the whole instalment schedule (admin correction). */
  router.put('/api/enrollments/:id/schedule', ({ user, params, body }) => {
    requireWrite(user, 'installments');
    const e = db.get('SELECT * FROM enrollments WHERE id = ?', [params.id]);
    if (!e) throw notFound('Enrollment not found');
    const paid = db.scalar(
      'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE enrollment_id = ? AND voided = 0', [params.id],
    );
    if (paid > 0) {
      throw badRequest('Payments exist against this schedule. Edit individual instalments instead.');
    }
    if (!Array.isArray(body.installments) || !body.installments.length) {
      throw badRequest('Send at least one instalment');
    }
    return db.tx(() => {
      generateInstallments(params.id, e.net_fee, null, e.enrolled_on, body.installments);
      audit(user, 'update', 'enrollments', params.id, 'schedule rebuilt');
      return enrollmentRow(params.id);
    });
  });

  router.del('/api/enrollments/:id', ({ user, params, body }) => {
    requireWrite(user, 'enrollments');
    const e = db.get('SELECT * FROM enrollments WHERE id = ?', [params.id]);
    if (!e) throw notFound('Enrollment not found');
    const paid = db.scalar(
      'SELECT COALESCE(SUM(amount),0) s FROM payments WHERE enrollment_id = ? AND voided = 0', [params.id],
    );
    if (paid > 0 && !body.force) {
      throw badRequest(
        `₹${money(paid)} has been collected against this enrollment. Deleting also deletes those ` +
        'receipts and changes your revenue reports. Set the status to Dropped instead, or resend with force.',
      );
    }
    db.run('DELETE FROM enrollments WHERE id = ?', [params.id]);
    audit(user, 'delete', 'enrollments', params.id, `student ${e.student_id}, course ${e.course_id}`);
    return { ok: true };
  });
};
