/** Modals shared by several screens: enrollment, payment, stage change. */

import { api, ApiError } from '../api.js';
import {
  h, fmt, formModal, toast, confirmDialog, todayStr, batchText, clear, OTHER_VALUE, addDaysStr,
  handleError,
} from '../ui.js';

// ------------------------------------------------------- enrollment
export function enrollmentModal({ meta, student, enrollment, students, onSaved }) {
  const editing = !!enrollment;
  const courses = meta.lookups.courses;
  /** Filled in by paintTotal on every keystroke — see the summary block below. */
  const summaryHost = h('div', { class: 'fee-summary' });
  /**
   * The instalment rows: one line each, with a date box the admin owns.
   * Kept apart from summaryHost because that one is rebuilt on every keystroke,
   * and rebuilding a date box while somebody is typing into it takes the
   * cursor with it. This is redrawn only when the number of instalments
   * changes; the amounts inside are written in place.
   */
  const scheduleHost = h('div', { class: 'fee-summary', style: { marginTop: '10px' } });

  /** How many instalments, and when each falls due. The dates are edited. */
  const split = { count: 1, dates: [], labels: [] };

  const fields = [
    { type: 'section', label: 'Student and course' },
    /*
     * Everything here stays editable after the fact — a wrong course or the
     * wrong student picked in a hurry has to be fixable. The student can only
     * be reassigned where the caller supplied a list to pick from; opened from
     * one student's own profile, it is their enrollment by definition.
     */
    (students || []).length
      ? {
        name: 'student_id', label: 'Student', type: 'select', required: true, placeholder: 'Choose a student',
        options: (students || []).map((s) => ({ value: s.id, label: `${s.name} — ${s.reg_no}` })),
        hint: editing ? 'Changing this moves the enrollment and its receipts.' : null,
      }
      : {
        name: 'student_label', label: 'Student', disabled: true,
        value: student ? `${student.name} (${student.reg_no})` : (enrollment ? enrollment.student_name : ''),
      },
    {
      name: 'course_id', label: 'Course', type: 'select', required: true, placeholder: 'Choose a course',
      options: courses.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })),
      hint: editing ? 'Changing this clears a batch that belongs to the old course.' : null,
      /*
       * A course we do not run yet can be typed in here — but unlike an
       * enquiry it cannot stay as loose text. An enrollment must point at a
       * real course: the fee schedule, the batch and every instalment hang off
       * one. So it is added to the course list as it is used, taking the fee
       * and GST typed below as its defaults, and the enrollment goes against
       * it. That is said plainly on the form rather than sprung afterwards.
       */
      other: {
        name: 'course_other',
        label: 'Other — not in this list',
        fieldLabel: 'Which course?',
        placeholder: 'e.g. Advanced Excel',
        hint: 'This will be added to your course list, using the fee and GST you set below.',
        error: 'Type the course, or pick one from the list',
      },
    },
    { name: 'batch_id', label: 'Batch', type: 'select', placeholder: 'Assign later' },
    {
      /*
       * One control where there were two. The fee-plan list was the older way
       * of splitting a fee and it sat right above this, so the form asked the
       * same question twice and could be answered two different ways — and a
       * course nobody had built a plan for could not be split at all, which
       * made a brand-new course behave unlike an established one. The plans
       * still live under Fees; enrolling no longer goes through them.
       *
       * Every course, new or long-standing, is billed the same way: pick one,
       * two or three parts and type the dates.
       */
      name: 'installment_count', label: 'Instalments', type: 'select', required: true,
      options: [
        { value: 1, label: '1 — pay in full' },
        { value: 2, label: '2 instalments' },
        { value: 3, label: '3 instalments' },
      ],
      hint: editing
        ? 'The schedule is rebuilt only while nothing has been collected.'
        : 'The total payable is divided equally. Set each due date below.',
    },

    { name: 'enrolled_on', label: 'Enrolled on', type: 'date', required: true },
    {
      name: 'status', label: 'Status', type: 'select', required: true,
      options: meta.enums.enrollment_status,
    },

    /*
     * No money is taken on this form. Enrolling and collecting are two acts —
     * "Record a payment" on the student does the second one, raises the receipt
     * and puts it against the right instalment. Doing it here as well meant two
     * ways to take the same rupee, and a payment that failed on its own after
     * the enrollment had already saved.
     *
     * The mode stays because it is not really about paying: it is what decides
     * whether a cash bill carries GST, and the tick box below hangs off it.
     */
    { type: 'section', label: 'Billing' },
    {
      name: 'payment_mode', label: 'Payment mode', type: 'select', required: true,
      options: meta.enums.payment_modes,
      hint: 'How this fee will be settled. Collect it with "Record a payment" on the student.',
    },

    { type: 'section', label: 'Fee and discount' },
    { name: 'gross_fee', label: 'Course fee', type: 'money', required: true },
    {
      name: 'tax_percent', label: 'GST %', type: 'number', step: '0.01', placeholder: '0',
    },
    {
      // only on show for cash; every other mode applies GST without asking
      name: 'gst_add', label: 'Add GST to this bill', type: 'checkbox', span: true,
      hint: 'Cash payment — untick to bill the fee without GST.',
    },
    {
      name: 'discount_type', label: 'Discount as', type: 'select', required: true,
      options: [
        { value: 'amount', label: '₹ Flat amount' },
        { value: 'percent', label: '% of the course fee' },
      ],
    },
    {
      name: 'discount', label: 'Discount', type: 'money', placeholder: '0',
      hint: 'A flat amount off the course fee.',
    },
    { name: 'discount_note', label: 'Reason for discount', span: true },
    // the running total sits last: everything above it feeds it, and the
    // instalment rows read off the total immediately below it
    { type: 'node', span: true, node: summaryHost },
    { type: 'node', span: true, node: scheduleHost },

    { type: 'section', label: 'Notes' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: true, rows: 2 },
  ];

  /** The institute GST rate, used until a course or plan says otherwise. */
  const defaultTax = Number(meta.settings.default_tax_percent) || 0;

  /*
   * A discount is stored as a flat amount — that is what receipts and reports
   * are built on — so a percentage is converted before it is sent. The form
   * opens on "flat amount" because that is what a saved record holds.
   */
  const values = editing
    ? {
      ...enrollment,
      discount_type: 'amount',
      payment_mode: 'Cash',
      // corrected below from the schedule this enrollment actually has
      installment_count: 1,
      // reflects what this enrollment actually carries, not a house default
      gst_add: Number(enrollment.tax_percent) > 0,
    }
    : {
      enrolled_on: todayStr(), status: 'Active',
      // left blank rather than pre-filled with 0 — the placeholder says zero
      discount: '', discount_type: 'amount', tax_percent: defaultTax,
      payment_mode: 'Cash', gst_add: true, installment_count: 1,
    };

  const ctl = formModal({
    title: editing ? `Edit enrollment — ${enrollment.course_name}` : 'Enroll a student',
    size: 'wide',
    fields,
    values,
    submitLabel: editing ? 'Save changes' : 'Create enrollment',
    async onSubmit(v, control) {
      const payload = { ...v };
      if (student) payload.student_id = student.id;
      delete payload.student_label;
      // the wire format is always a flat amount; the server recomputes the net
      // fee from the course fee, the discount and the GST rate
      if (v.discount_type === 'percent' && Number(v.discount) > 100) {
        ctl.form.setErrors({ discount: 'A discount cannot be more than 100%' });
        return;
      }
      payload.discount = discountAmount();
      delete payload.discount_type;

      /*
       * The schedule goes with the enrollment rather than being left to be
       * derived from a plan afterwards — the number of parts and the dates were
       * both decided on this form, and a plan template knows neither.
       */
      const parts = amounts(payable(), split.count);
      payload.installments = parts.map((amount, i) => ({
        sequence: i + 1,
        label: split.labels[i] || (split.count === 1 ? 'Full payment' : `Instalment ${i + 1}`),
        amount,
        due_date: split.dates[i] || null,
      }));

      // both only drive the GST box on screen; the rate itself is what is stored
      for (const k of ['payment_mode', 'gst_add', 'installment_count']) delete payload[k];

      const send = async (extra = {}) => (editing
        ? api.put(`/api/enrollments/${enrollment.id}`, { ...payload, ...extra })
        : api.post('/api/enrollments', { ...payload, ...extra }));

      let saved;
      try {
        saved = await send();
      } catch (err) {
        // Full batches and repeat enrollments are confirmable, not fatal.
        const confirmable = err instanceof ApiError
          && (/is full/.test(err.message) || /already has an active enrollment/.test(err.message));
        if (!confirmable) throw err;
        const go = await confirmDialog({
          title: 'Confirm', message: `${err.message} Continue anyway?`, confirmLabel: 'Continue',
        });
        if (!go) return;
        saved = await send({ allow_overbook: true, allow_duplicate: true });
      }

      control.close();
      /*
       * Some edits are handled rather than obeyed — a batch dropped because the
       * course changed, a schedule left alone because money is already on it.
       * Say so, or the record quietly differs from what was typed.
       */
      const did = (saved && saved.notes && saved.notes.length) ? ` · ${saved.notes.join(' · ')}` : '';
      // the welcome note is its own outcome and is never silently swallowed
      const w = saved && saved.welcome;
      if (w && !w.sent && w.reason && w.reason !== 'Welcome emails are switched off') {
        toast(`Enrolled, but the welcome email did not go out — ${w.reason}`, 'warn', 7000);
      }
      const welcomed = w && w.sent ? ` · welcome email sent to ${w.to}` : '';
      toast(`${editing ? 'Enrollment updated' : 'Student enrolled'}${did}${welcomed}`, 'good');

      /*
       * A course joining the list is a change to the whole app, not to this one
       * enrollment, so it is said out loud and the shared lookup is brought up
       * to date in place — otherwise the very next form would still be offering
       * the old list and it would look as though nothing had been added.
       */
      const addedCourse = saved && saved.course_added;
      if (addedCourse && !addedCourse.existing) {
        toast(`${addedCourse.name} added to your course list as ${addedCourse.code} · check it under Courses`,
          'good', 7000);
        if (!courses.some((x) => x.id === addedCourse.id)) {
          courses.push({
            id: addedCourse.id,
            code: addedCourse.code,
            name: addedCourse.name,
            base_fee: Number(v.gross_fee) || 0,
            tax_percent: Number(v.tax_percent) || 0,
          });
          courses.sort((a, b) => a.name.localeCompare(b.name));
        }
      } else if (addedCourse) {
        toast(`Enrolled on ${addedCourse.name} (${addedCourse.code}), which was already on your course list`,
          'good', 6000);
      }
      if (onSaved) onSaved();
    },
  });

  // --- keep batch/plan lists and the fee in step with the chosen course
  const c = ctl.form.controls;
  const syncCourse = (prefillFee) => {
    const courseId = Number(c.course_id.input.value);
    const course = courses.find((x) => x.id === courseId);

    const fill = (select, rows, labeller, keep) => {
      const previous = keep ? select.value : '';
      select.replaceChildren(h('option', { value: '' }, select.dataset.blank || '— none —'));
      for (const r of rows) select.appendChild(h('option', { value: r.id }, labeller(r)));
      select.value = previous;
    };

    c.batch_id.input.dataset.blank = 'Assign later';
    fill(c.batch_id.input, meta.lookups.batches.filter((b) => b.course_id === courseId),
      (b) => `${b.code} · starts ${fmt.batch(b.start_date) || '—'} · ${b.status} · ${b.filled}/${b.capacity} seats`,
      true);

    if (prefillFee && course) {
      c.gross_fee.input.value = course.base_fee;
      // a course set to 0 is genuinely zero-rated; only a missing rate defaults
      c.tax_percent.input.value = course.tax_percent == null ? defaultTax : course.tax_percent;
    } else if (prefillFee && c.course_id.input.value === OTHER_VALUE) {
      /*
       * Switching to a course we do not run yet clears the fee rather than
       * leaving the last course's behind. That figure would not merely be
       * shown — it becomes the new course's standard fee, so a leftover 65,000
       * from the course looked at a moment ago would be wrong twice over.
       */
      c.gross_fee.input.value = '';
      c.tax_percent.input.value = defaultTax;
    }

    paintTotal();
  };

  /** The rate this enrollment's course charges. */
  function courseRate() {
    const course = courses.find((x) => x.id === Number(c.course_id.input.value));
    return course && course.tax_percent != null ? Number(course.tax_percent) : defaultTax;
  }

  /*
   * Cash is the only mode that gets a say: the tick box appears and decides
   * whether GST goes on. Every other mode applies the course's rate straight
   * away, so the box is put away and the rate restored.
   *
   * Nothing is rewritten merely by opening the form — the mode box always
   * reads "Cash", and acting on that would strip GST off an existing
   * enrollment that someone opened only to read.
   */
  function applyGstChoice({ fromUser }) {
    const isCash = c.payment_mode.input.value === 'Cash';
    c.gst_add.input.closest('.field').style.display = isCash ? '' : 'none';

    if (!fromUser) return;
    if (!isCash) {
      c.gst_add.input.checked = true;
      c.tax_percent.input.value = courseRate();
    } else {
      c.tax_percent.input.value = c.gst_add.input.checked ? courseRate() : 0;
    }
    paintTotal();
  }

  const num = (name) => Number(c[name].input.value) || 0;
  const round2 = (n) => Math.round(n * 100) / 100;

  /** What comes off the fee, whichever way it was typed. */
  function discountAmount() {
    const entered = num('discount');
    return c.discount_type.input.value === 'percent'
      ? round2((num('gross_fee') * entered) / 100)
      : round2(entered);
  }

  /** Money for the summary: paise only when there are paise to show. */
  const rupees = (n) => fmt.money(n, { decimals: n % 1 ? 2 : 0 });

  const line = (label, value, { note, cls = '' } = {}) => h('div', { class: `row ${cls}` },
    h('span', {}, label, note ? h('span', { class: 'note' }, ` ${note}`) : null),
    h('span', { class: 'v' }, value));

  /** The date the schedule counts from — the same one the server uses. */
  function scheduleStart() {
    const batch = meta.lookups.batches.find((b) => b.id === Number(c.batch_id.input.value));
    return (batch && batch.start_date) || c.enrolled_on.input.value || todayStr();
  }

  /** What the total payable comes to right now. */
  function payable() {
    const taxable = round2(num('gross_fee') - discountAmount());
    return round2(taxable + round2((taxable * num('tax_percent')) / 100));
  }

  /**
   * Divide the payable total into `count` equal parts, the last absorbing the
   * rounding so the parts always add back to the whole — the same rule the
   * server applies, so what is previewed is what is written.
   *
   * Equal parts, on every course alike. Fee-plan templates used to decide this,
   * and they were written against the fee before GST — so a ₹17,700 bill was
   * being divided by a template built on ₹15,000 to arrive at the same thirds,
   * only less obviously and only for courses that happened to have a template.
   */
  function amounts(total, count) {
    const each = round2(total / count);
    return Array.from({ length: count }, (_, i) => (i === count - 1
      ? round2(total - each * (count - 1))
      : each));
  }

  /** A starting point only: the first due now, the rest a month apart. */
  function defaultDates(count) {
    const start = scheduleStart();
    return Array.from({ length: count }, (_, i) => addDaysStr(start, i * 30));
  }

  function defaultLabels(count) {
    if (count === 1) return ['Full payment'];
    return Array.from({ length: count }, (_, i) => `Instalment ${i + 1}`);
  }

  /**
   * Rebuild the instalment rows. Called when the count changes, or when the
   * date everything counts from moves — not on every keystroke, because each
   * row owns a date box somebody may be typing into.
   */
  function renderSchedule() {
    const count = Number(c.installment_count.input.value) || 1;
    split.count = count;
    split.dates = defaultDates(count);
    split.labels = defaultLabels(count);

    const rows = [line(
      count === 1 ? 'One payment' : `Split into ${count} instalments`,
      '', { cls: 'total' },
    )];
    split.amounts = amounts(payable(), count);
    for (let i = 0; i < count; i += 1) {
      const box = h('input', {
        class: 'input', type: 'date', value: split.dates[i],
        style: { width: '150px', padding: '4px 8px', fontSize: '13px' },
        onChange: (e) => { split.dates[i] = e.target.value; },
      });
      rows.push(h('div', { class: 'row' },
        h('span', {}, split.labels[i]),
        box,
        h('span', { class: 'v', dataset: { part: String(i) } }, rupees(split.amounts[i]))));
    }
    rows.push(h('div', { class: 'note', style: { marginTop: '6px' } },
      count === 1
        ? 'The whole fee is due on this date.'
        : 'Equal parts of the total payable. Change any due date above.'));
    clear(scheduleHost).append(...rows);
    paintParts();
  }

  /** Write the current amounts into the rows already on screen. */
  function paintParts() {
    const parts = amounts(payable(), split.count);
    split.amounts = parts;
    scheduleHost.querySelectorAll('[data-part]').forEach((el, i) => {
      el.textContent = rupees(parts[i]);
    });
  }

  /**
   * The same arithmetic the server runs on save, shown a step at a time: GST
   * applies to the fee after the discount, never to the discount itself. A
   * discount larger than the fee shows as a negative total rather than being
   * hidden — the save is refused anyway, so the number should say why.
   */
  function paintTotal() {
    // rounded in the same order as the server, so the two never differ by a paisa
    const gross = num('gross_fee');
    const discount = discountAmount();
    const taxable = round2(gross - discount);
    const gst = round2((taxable * num('tax_percent')) / 100);
    const total = round2(taxable + gst);
    const percent = c.discount_type.input.value === 'percent';

    // spell the percentage out in rupees, so what is coming off is never a guess
    const hint = c.discount.input.closest('.field').querySelector('.hint');
    hint.textContent = percent
      ? `${num('discount')}% of ${rupees(gross)} = ${rupees(discount)}`
      : 'A flat amount off the course fee.';
    c.discount.input.max = percent ? '100' : '';

    const rows = [line('Course fee', rupees(gross))];
    if (discount) {
      rows.push(line('Discount', `− ${rupees(discount)}`,
        { note: percent ? `(${num('discount')}% off)` : null }));
      rows.push(line('Fee after discount', rupees(taxable)));
    }
    // no GST line at all when none applies, rather than a row of zeroes
    if (num('tax_percent')) rows.push(line(`GST ${num('tax_percent')}%`, `+ ${rupees(gst)}`));
    rows.push(h('div', { class: 'rule' }));
    // the summary ends at what is payable; collections are tracked elsewhere
    rows.push(line('Total payable', rupees(total), { cls: 'total' }));
    clear(summaryHost).append(...rows);
    // the split sits in its own box below and only its figures are refreshed,
    // so a half-typed due date is not swept away by a keystroke in the fee
    paintParts();
  }

  for (const name of ['gross_fee', 'discount', 'tax_percent']) {
    c[name].input.addEventListener('input', paintTotal);
  }
  c.discount_type.input.addEventListener('change', paintTotal);
  c.payment_mode.input.addEventListener('change', () => applyGstChoice({ fromUser: true }));
  c.gst_add.input.addEventListener('change', () => applyGstChoice({ fromUser: true }));

  c.course_id.input.addEventListener('change', () => syncCourse(true));
  // the count, and anything that moves the date it all counts from
  c.installment_count.input.addEventListener('change', renderSchedule);
  c.batch_id.input.addEventListener('change', renderSchedule);
  c.enrolled_on.input.addEventListener('change', renderSchedule);

  syncCourse(false);
  applyGstChoice({ fromUser: false });   // show or hide the box, change nothing
  if (editing) c.batch_id.input.value = enrollment.batch_id || '';
  renderSchedule();
  /*
   * An enrollment being edited already has a schedule; show the one it has
   * rather than a fresh guess, so opening the form to change a remark does not
   * quietly propose rewriting the dates.
   */
  if (editing) {
    const showExisting = (rows) => {
      if (!rows || !rows.length) return;
      c.installment_count.input.value = String(Math.min(3, rows.length));
      renderSchedule();
      rows.slice(0, split.count).forEach((it, i) => { split.dates[i] = String(it.due_date || '').slice(0, 10); });
      split.labels = rows.slice(0, split.count).map((it) => it.label);
      redrawDates();
    };
    // the caller usually hands over the full record already; only go back to
    // the server when it did not
    if (enrollment.installments) showExisting(enrollment.installments);
    else {
      api.get(`/api/enrollments/${enrollment.id}`)
        .then((full) => showExisting(full.installments))
        .catch(() => { /* the form still works without it */ });
    }
  }

  /** Push the dates held in `split` back onto the boxes on screen. */
  function redrawDates() {
    const boxes = scheduleHost.querySelectorAll('input[type=date]');
    boxes.forEach((b, i) => { if (split.dates[i]) b.value = split.dates[i]; });
    const labels = scheduleHost.querySelectorAll('.row > span:first-child');
    split.labels.forEach((l, i) => { if (labels[i + 1]) labels[i + 1].textContent = l; });
  }

  return ctl;
}

// ---------------------------------------------------------- payment
export function paymentModal({ meta, student, enrollments, preselect, onSaved }) {
  const open = (enrollments || []).filter((e) => e.status !== 'Dropped');
  if (!open.length) {
    toast('This student has no enrollment to collect against. Create an enrollment first.', 'warn', 6000);
    return null;
  }

  const balanceOf = (e) => Number(e.net_fee) - Number(e.paid || 0);

  /**
   * Record the payment, and print only if that is what was asked for.
   *
   * Recording money and printing a slip of paper are two separate acts, and
   * one button used to do both — so every payment threw a print tab at you
   * whether or not the student was standing there wanting one. They are two
   * buttons now, and this is the part they share.
   *
   * Printing later is not a dead end either: every receipt has its own Print
   * button on the Payments screen and on the student's own Receipts card.
   */
  async function record(v, control, wantPrint) {
    const send = (extra) => api.post('/api/payments', { ...v, ...extra });
    let saved;
    try {
      saved = await send();
    } catch (err) {
      if (!(err instanceof ApiError) || !/more than the/.test(err.message)) throw err;
      const go = await confirmDialog({
        title: 'Amount exceeds the balance',
        message: `${err.message} Record it as an advance?`,
        confirmLabel: 'Record anyway',
      });
      if (!go) return;
      saved = await send({ allow_overpay: true });
    }
    control.close();
    if (wantPrint) {
      toast(`Receipt ${saved.receipt_no} recorded — opening it to print`, 'good');
      api.openTab(`/api/payments/${saved.id}/receipt`);
    } else {
      // says where the receipt is, so not printing now is not losing it
      toast(`Receipt ${saved.receipt_no} recorded · print it any time from Payments`, 'good', 6000);
    }
    if (onSaved) onSaved(saved);
  }

  /** The second button: records exactly as above, and opens the receipt too. */
  const printBtn = h('button', { class: 'btn' }, '🖨 Record & print');
  printBtn.addEventListener('click', async () => {
    const v = ctl.form.validate();
    if (!v) return;
    printBtn.disabled = true;
    const original = printBtn.textContent;
    printBtn.textContent = 'Saving…';
    try {
      await record(v, ctl, true);
    } catch (err) {
      handleError(err, ctl.form);
    } finally {
      printBtn.disabled = false;
      printBtn.textContent = original;
    }
  });

  const ctl = formModal({
    title: `Record a payment${student ? ` — ${student.name}` : ''}`,
    fields: [
      {
        name: 'enrollment_id', label: 'Against enrollment', type: 'select', required: true, span: true,
        options: open.map((e) => ({
          value: e.id,
          label: `${e.course_name}${e.batch_code ? ` · ${batchText(e.batch_start, e.batch_code)}` : ''} — ${fmt.money(balanceOf(e))} due`,
        })),
      },
      { type: 'node', span: true, node: h('div', { class: 'alert info', id: 'pay-balance' }) },
      { name: 'amount', label: 'Amount', type: 'money', required: true },
      { name: 'mode', label: 'Mode', type: 'select', required: true, options: meta.enums.payment_modes },
      { name: 'paid_on', label: 'Paid on', type: 'date', required: true },
      { name: 'reference', label: 'Reference / txn no.' },
      { name: 'collected_by', label: 'Collected by' },
      { name: 'remarks', label: 'Remarks', type: 'textarea', span: true, rows: 2 },
    ],
    values: {
      enrollment_id: preselect || open[0].id,
      mode: 'Cash',
      paid_on: todayStr(),
      amount: '',
    },
    submitLabel: 'Record payment',
    extraFooter: printBtn,
    onSubmit: (v, control) => record(v, control, false),
  });

  // Live balance hint + amount prefill from the next unpaid instalment.
  const c = ctl.form.controls;
  const box = ctl.modal.querySelector('#pay-balance');
  const sync = async () => {
    const e = open.find((x) => x.id === Number(c.enrollment_id.input.value));
    if (!e) return;
    const balance = balanceOf(e);
    box.replaceChildren(h('div', {},
      h('b', {}, `${fmt.money(balance)} outstanding`),
      h('span', { class: 'small' }, ` of ${fmt.money(e.net_fee)} for ${e.course_name}.`)));
    try {
      const detail = await api.get(`/api/enrollments/${e.id}`);
      const next = detail.installments.find((i) => ['Pending', 'Partial'].includes(i.status));
      if (next && !c.amount.input.value) {
        c.amount.input.value = Math.round((next.amount - next.paid_amount) * 100) / 100;
        box.appendChild(h('div', { class: 'small', style: { marginTop: '4px' } },
          `Next due: ${next.label} — ${fmt.money(next.amount - next.paid_amount)} on ${fmt.date(next.due_date)}`));
      }
    } catch (_) { /* the hint is optional */ }
  };
  c.enrollment_id.input.addEventListener('change', () => { c.amount.input.value = ''; sync(); });
  sync();

  return ctl;
}

// ------------------------------------------------------------ stage
export function stageModal({ meta, student, onSaved }) {
  return formModal({
    title: `Move ${student.name} to a new stage`,
    size: 'narrow',
    fields: [
      {
        name: 'stage', label: 'New stage', type: 'select', required: true, span: true,
        options: meta.enums.student_stages,
      },
      { name: 'note', label: 'Note (optional)', type: 'textarea', span: true, rows: 2 },
    ],
    values: { stage: student.stage },
    submitLabel: 'Move stage',
    async onSubmit(v, ctl) {
      if (v.stage === student.stage) { ctl.close(); return; }
      await api.post(`/api/students/${student.id}/stage`, v);
      ctl.close();
      toast(`Moved to ${v.stage}`, 'good');
      if (onSaved) onSaved();
    },
  });
}
