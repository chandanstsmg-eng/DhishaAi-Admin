import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, statTile, tabs, formModal, toast,
  confirmDialog, clear, progressBar, batchText, todayStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';
import { studentModal } from './students.js';
import { enrollmentModal, paymentModal, stageModal } from './shared-forms.js';

export default async function studentDetail({ params, query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  let s = await api.get(`/api/students/${params.id}`);
  let tab = query.tab || 'overview';

  const reload = async () => {
    s = await api.get(`/api/students/${params.id}`);
    render();
  };

  function render() {
    clear(host);

    // ------------------------------------------------------- header
    const actions = [
      h('button', { class: 'btn', onClick: () => stageModal({ meta, student: s, onSaved: reload }) }, '⇉ Move stage'),
      h('button', { class: 'btn', onClick: () => studentModal({ meta, student: s, onSaved: reload }) }, '✎ Edit'),
      h('button', {
        class: 'btn navy',
        onClick: () => enrollmentModal({ meta, student: s, onSaved: reload }),
      }, '+ Enroll in a course'),
      s.enrollments.length
        ? h('button', {
          class: 'btn primary',
          onClick: () => paymentModal({ meta, student: s, enrollments: s.enrollments, onSaved: reload }),
        }, '₹ Record payment')
        : null,
      h('button', { class: 'btn danger', onClick: removeStudent }, '🗑 Delete'),
    ];

    host.appendChild(pageHead(
      s.name,
      `${s.reg_no} · ${s.phone}${s.email ? ` · ${s.email}` : ''}`,
      actions,
    ));

    host.appendChild(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' } },
      badge(s.status), badge(s.stage),
      s.city ? badge(s.city, 'navy') : null,
      s.source ? badge(s.source, 'navy') : null,
      h('a', { href: '#/students', class: 'small muted', style: { marginLeft: 'auto', alignSelf: 'center' } }, '← All students')));

    // -------------------------------------------------------- tiles
    host.appendChild(h('div', { class: 'tiles' },
      statTile({ label: 'Total fee', value: fmt.money(s.total_fee), sub: `${s.enrollments.length} enrollment(s)` }),
      statTile({ label: 'Paid', value: fmt.money(s.total_paid), tone: 'good', sub: `${s.payments.length} receipt(s)` }),
      statTile({
        label: 'Balance', value: fmt.money(s.balance),
        tone: s.balance > 0 ? (s.overdue_amount > 0 ? 'danger' : 'warn') : 'good',
        sub: s.overdue_amount > 0 ? `${fmt.money(s.overdue_amount)} overdue` : (s.balance > 0 ? 'On schedule' : 'Fully paid'),
      }),
      statTile({
        label: 'Attendance',
        value: s.attendance.percent == null ? '—' : `${s.attendance.percent}%`,
        tone: s.attendance.percent == null ? '' : s.attendance.percent >= 75 ? 'good' : 'warn',
        sub: `${s.attendance.present || 0} of ${s.attendance.total || 0} sessions`,
      })));

    // --------------------------------------------------------- tabs
    host.appendChild(tabs([
      { key: 'overview', label: 'Overview' },
      { key: 'fees', label: 'Fees & payments', count: s.payments.length },
      { key: 'documents', label: 'Documents', count: s.documents.length },
      { key: 'placements', label: 'Placements', count: s.placements.length },
      { key: 'history', label: 'History' },
    ], tab, (k) => { tab = k; setQuery({ tab: k }); render(); }));

    host.appendChild(({ overview, fees, documents, placements, history })[tab]());
  }

  // ------------------------------------------------------- overview
  function overview() {
    const profile = card('Profile', h('dl', { class: 'kv' },
      ...[
        ['Registration no.', s.reg_no],
        ['Phone', s.phone],
        ['Alternate phone', s.alt_phone],
        ['Email', s.email],
        ['Date of birth', s.dob ? fmt.date(s.dob) : ''],
        ['Gender', s.gender],
        ['Qualification', s.qualification],
        ['College', s.college],
        ['Year of passing', s.passout_year],
        ['Experience', s.experience],
        ['Address', [s.address, s.city, s.state, s.pincode].filter(Boolean).join(', ')],
        ['Guardian', s.guardian_name ? `${s.guardian_name}${s.guardian_phone ? ` (${s.guardian_phone})` : ''}` : ''],
        ['Source', s.source],
        ['Joined on', s.joined_on ? fmt.date(s.joined_on) : ''],
        ['Notes', s.notes],
      ].flatMap(([k, v]) => [
        h('dt', {}, k),
        h('dd', {}, v || h('span', { class: 'muted' }, '—')),
      ]),
    ));

    const enrollmentCards = s.enrollments.length
      ? h('div', { style: { display: 'grid', gap: '12px' } }, s.enrollments.map((e) => {
        const paidPct = e.net_fee ? (e.paid / e.net_fee) * 100 : 0;
        return card(e.course_name, h('div', {},
          h('div', { class: 'small muted', style: { marginBottom: '10px' } },
            `${batchText(e.batch_start, e.batch_code) || 'No batch assigned'}${e.trainer_name ? ` · ${e.trainer_name}` : ''}`,
            e.time_slot ? ` · ${e.time_slot}` : ''),
          h('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap', marginBottom: '10px' } },
            h('div', {}, h('div', { class: 'small muted' }, 'Fee'), h('b', {}, fmt.money(e.net_fee))),
            h('div', {}, h('div', { class: 'small muted' }, 'Paid'), h('b', { class: 'money-pos' }, fmt.money(e.paid))),
            h('div', {}, h('div', { class: 'small muted' }, 'Balance'),
              h('b', { class: e.balance > 0 ? 'money-neg' : 'money-pos' }, fmt.money(e.balance))),
            e.discount > 0
              ? h('div', {}, h('div', { class: 'small muted' }, 'Discount'), h('b', {}, fmt.money(e.discount)))
              : null),
          progressBar(paidPct),
          h('div', { style: { display: 'flex', gap: '7px', marginTop: '12px', flexWrap: 'wrap' } },
            h('button', {
              class: 'btn sm',
              onClick: () => enrollmentModal({ meta, student: s, enrollment: e, onSaved: reload }),
            }, 'Edit'),
            h('button', {
              class: 'btn sm primary',
              onClick: () => paymentModal({ meta, student: s, enrollments: s.enrollments, preselect: e.id, onSaved: reload }),
            }, 'Collect fee'),
            e.batch_code
              ? h('button', { class: 'btn sm', onClick: () => navigate(`/batches/${e.batch_id}`) }, 'Open batch')
              : null,
            h('button', {
              class: 'btn sm danger',
              onClick: () => removeEnrollment(e),
            }, 'Remove'))),
        { right: badge(e.status) });
      }))
      : card('Enrollments', h('div', { class: 'dt-empty' },
        h('div', { class: 'big' }, '◍'),
        h('div', {}, 'Not enrolled in any course yet'),
        h('button', {
          class: 'btn primary', style: { marginTop: '12px' },
          onClick: () => enrollmentModal({ meta, student: s, onSaved: reload }),
        }, '+ Enroll in a course')));

    return h('div', { class: 'grid s12' }, profile, enrollmentCards);
  }

  async function removeEnrollment(e) {
    const go = await confirmDialog({
      title: 'Remove enrollment',
      message: e.paid > 0
        ? `${fmt.money(e.paid)} has been collected against ${e.course_name}. Removing the enrollment deletes those receipts and changes your reports. Prefer setting the status to Dropped.`
        : `Remove ${s.name} from ${e.course_name}? The fee schedule is deleted too.`,
      confirmLabel: 'Remove',
      danger: true,
      requirePhrase: e.paid > 0 ? 'DELETE' : null,
    });
    if (!go) return;
    await api.del(`/api/enrollments/${e.id}`, { force: true });
    toast('Enrollment removed', 'good');
    reload();
  }

  // ----------------------------------------------------------- fees
  function fees() {
    const scheduleCards = s.enrollments.map((e) => card(
      `${e.course_name} — fee schedule`,
      dataTable({
        columns: [
          { key: 'label', label: 'Instalment' },
          { key: 'due_date', label: 'Due', render: (r) => h('span', {}, fmt.date(r.due_date)) },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmt.money(r.amount) },
          { key: 'paid_amount', label: 'Paid', align: 'right', render: (r) => fmt.money(r.paid_amount) },
          {
            key: 'balance', label: 'Balance', align: 'right',
            render: (r) => h('span', { class: r.amount - r.paid_amount > 0 ? 'money-neg' : '' },
              fmt.money(r.amount - r.paid_amount)),
          },
          {
            key: 'status', label: 'Status', render: (r) => h('div', {},
              badge(r.status),
              r.status !== 'Paid' && r.status !== 'Waived' && r.due_date < todayStr()
                ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, 'overdue') : null),
          },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              r.status === 'Waived'
                ? h('button', { class: 'btn sm', onClick: () => unwaive(r) }, 'Un-waive')
                : r.status !== 'Paid'
                  ? h('button', { class: 'btn sm', onClick: () => waive(r) }, 'Waive')
                  : null),
          },
        ],
        rows: e.installments,
        empty: 'No instalments on this enrollment',
        footer: {
          label: 'Total',
          amount: fmt.money(e.net_fee),
          paid_amount: fmt.money(e.paid),
          balance: fmt.money(e.balance),
        },
      }),
      {
        flush: true,
        sub: `${batchText(e.batch_start, e.batch_code) || 'No batch'} · enrolled ${fmt.date(e.enrolled_on)}`,
      },
    ));

    const receipts = card('Receipts', dataTable({
      columns: [
        { key: 'receipt_no', label: 'Receipt no.', render: (r) => h('span', { class: 'mono strong' }, r.receipt_no) },
        { key: 'paid_on', label: 'Date', render: (r) => fmt.date(r.paid_on) },
        { key: 'course_name', label: 'Course' },
        { key: 'mode', label: 'Mode', render: (r) => badge(r.mode, 'navy') },
        { key: 'reference', label: 'Reference', render: (r) => h('span', { class: 'small muted' }, r.reference || '—') },
        {
          key: 'amount', label: 'Amount', align: 'right',
          render: (r) => h('span', { class: r.voided ? 'muted' : 'strong' },
            fmt.money(r.amount), r.voided ? ' (void)' : ''),
        },
        {
          // the two buttons that act on the receipt, under a heading of their own
          key: 'receipt_actions', label: 'Receipt', align: 'center',
          render: (r) => h('div', { class: 'row-actions' },
            h('button', { class: 'btn sm', onClick: () => api.openTab(`/api/payments/${r.id}/receipt`) }, 'Print'),
            r.voided ? null : h('button', { class: 'btn sm', onClick: () => emailReceipt(r) }, '✉ Email')),
        },
        {
          key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
            r.voided ? null : h('button', { class: 'btn sm danger', onClick: () => voidPayment(r) }, 'Void')),
        },
      ],
      rows: s.payments,
      empty: 'No payments recorded yet',
    }), { flush: true });

    return h('div', { style: { display: 'grid', gap: '14px' } }, ...scheduleCards, receipts);
  }

  /** Send the bill to this student's own address, editable for a one-off. */
  function emailReceipt(r) {
    formModal({
      title: `Email receipt ${r.receipt_no}`,
      size: 'narrow',
      fields: [{
        name: 'to', label: 'Send to', type: 'email', required: true, span: true,
        hint: s.email
          ? `The bill for ${fmt.money(r.amount)} goes out as an attachment.`
          : `${s.name} has no email saved — add one above to have it filled in next time.`,
      }],
      values: { to: s.email || '' },
      submitLabel: 'Send receipt',
      async onSubmit(v, ctl) {
        await api.post(`/api/payments/${r.id}/email`, v);
        ctl.close();
        toast(`Receipt ${r.receipt_no} emailed to ${v.to}`, 'good');
      },
    });
  }

  async function waive(inst) {
    formModal({
      title: `Waive ${inst.label}`,
      size: 'narrow',
      fields: [{
        name: 'reason', label: 'Reason for the waiver', type: 'textarea', required: true, span: true,
        hint: 'This reduces the payable fee and is recorded in the audit log.',
      }],
      submitLabel: 'Waive instalment',
      async onSubmit(v, ctl) {
        await api.post(`/api/installments/${inst.id}/waive`, v);
        ctl.close();
        toast('Instalment waived', 'good');
        reload();
      },
    });
  }

  async function unwaive(inst) {
    const go = await confirmDialog({
      title: 'Reverse the waiver',
      message: `Restore ${fmt.money(inst.amount - inst.paid_amount)} to the payable fee?`,
      confirmLabel: 'Reverse waiver',
    });
    if (!go) return;
    await api.post(`/api/installments/${inst.id}/unwaive`);
    toast('Waiver reversed', 'good');
    reload();
  }

  function voidPayment(p) {
    formModal({
      title: `Void receipt ${p.receipt_no}`,
      size: 'narrow',
      fields: [{
        name: 'reason', label: 'Why is this being voided?', type: 'textarea', required: true, span: true,
        hint: 'The receipt is kept for the audit trail and marked VOID; the money is removed from all reports.',
      }],
      submitLabel: 'Void receipt',
      async onSubmit(v, ctl) {
        await api.post(`/api/payments/${p.id}/void`, v);
        ctl.close();
        toast('Receipt voided', 'good');
        reload();
      },
    });
  }

  // ------------------------------------------------------ documents
  function documents() {
    return card('Documents', dataTable({
      columns: [
        { key: 'doc_type', label: 'Document', render: (r) => h('span', { class: 'strong' }, r.doc_type) },
        { key: 'doc_no', label: 'Number' },
        { key: 'file_name', label: 'File / location' },
        { key: 'verified', label: 'Verified', render: (r) => badge(r.verified ? 'Verified' : 'Pending', r.verified ? 'good' : 'warn') },
        { key: 'remarks', label: 'Remarks', render: (r) => h('span', { class: 'small muted' }, r.remarks || '—') },
        { key: 'uploaded_at', label: 'Added', align: 'right', render: (r) => h('span', { class: 'small' }, fmt.date(r.uploaded_at)) },
        {
          key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
            h('button', { class: 'btn sm', onClick: () => docModal(r) }, 'Edit'),
            h('button', { class: 'btn sm danger', onClick: () => removeDoc(r) }, '×')),
        },
      ],
      rows: s.documents,
      empty: 'No documents recorded',
      emptyHint: 'Track which certificates and ID proofs have been collected and verified.',
    }), {
      flush: true,
      right: h('button', { class: 'btn sm primary', onClick: () => docModal() }, '+ Add document'),
    });
  }

  function docModal(doc) {
    formModal({
      title: doc ? 'Edit document' : 'Add a document',
      fields: [
        { name: 'doc_type', label: 'Document type', type: 'select', required: true, options: meta.enums.doc_types },
        { name: 'doc_no', label: 'Document number' },
        {
          name: 'file_name', label: 'File name or location', span: true,
          hint: 'This portal records that a document was collected; store the file itself in your usual folder.',
        },
        { name: 'verified', label: 'Verified', type: 'checkbox' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', span: true, rows: 2 },
      ],
      values: doc || {},
      submitLabel: doc ? 'Save' : 'Add document',
      async onSubmit(v, ctl) {
        if (doc) await api.put(`/api/students/${s.id}/documents/${doc.id}`, v);
        else await api.post(`/api/students/${s.id}/documents`, v);
        ctl.close();
        toast('Document saved', 'good');
        reload();
      },
    });
  }

  /**
   * Delete the student record. Money already collected is the dangerous case:
   * the server refuses unless `force` is set, so ask a second time and make the
   * consequence explicit rather than quietly forcing it.
   */
  async function removeStudent() {
    const collected = (s.enrollments || []).reduce((sum, e) => sum + (Number(e.paid) || 0), 0);

    const go = await confirmDialog({
      title: 'Delete student',
      danger: true,
      confirmLabel: 'Delete',
      message: collected > 0
        ? `${s.name} (${s.reg_no}) has ${fmt.money(collected)} of recorded payments. Deleting removes the student, their enrollments, fee schedule and receipts — and takes that money out of every report. Setting the stage to Dropped keeps the history instead.`
        : `Delete ${s.name} (${s.reg_no})? Their enrollments, fee schedule, attendance and documents go too. This cannot be undone.`,
      requirePhrase: collected > 0 ? 'DELETE' : undefined,
    });
    if (!go) return;

    try {
      await api.del(`/api/students/${s.id}`, collected > 0 ? { force: true } : undefined);
      toast(`${s.name} deleted`, 'good');
      navigate('/students');
    } catch (err) {
      toast(err.message || 'Could not delete this student', 'danger', 6000);
    }
  }

  async function removeDoc(doc) {
    const go = await confirmDialog({
      title: 'Remove document', message: `Remove the ${doc.doc_type} record?`, danger: true, confirmLabel: 'Remove',
    });
    if (!go) return;
    await api.del(`/api/students/${s.id}/documents/${doc.id}`);
    toast('Document removed', 'good');
    reload();
  }

  // ----------------------------------------------------- placements
  function placements() {
    return card('Placement activity', dataTable({
      columns: [
        { key: 'company', label: 'Company', render: (r) => h('span', { class: 'strong' }, r.company) },
        { key: 'role', label: 'Role' },
        { key: 'package_lpa', label: 'Package', align: 'right', render: (r) => (r.package_lpa ? `${r.package_lpa} LPA` : '—') },
        { key: 'location', label: 'Location' },
        { key: 'status', label: 'Status', render: (r) => badge(r.status) },
        { key: 'offer_date', label: 'Offer', align: 'right', render: (r) => fmt.dateShort(r.offer_date) },
      ],
      rows: s.placements,
      empty: 'No placement activity yet',
      emptyHint: 'Log applications and interviews from the Placements screen.',
    }), {
      flush: true,
      right: h('a', { href: '#/placements', class: 'btn sm' }, 'Open placements'),
    });
  }

  // -------------------------------------------------------- history
  function history() {
    return h('div', { class: 'grid c2' },
      card('Lifecycle history',
        s.stage_history.length
          ? h('div', { class: 'timeline' }, s.stage_history.map((x) => h('div', { class: 'item' },
            h('div', {}, h('b', {}, x.to_stage),
              x.from_stage ? h('span', { class: 'muted' }, ` from ${x.from_stage}`) : null),
            x.note ? h('div', { class: 'small' }, x.note) : null,
            h('div', { class: 'when' }, `${fmt.dateTime(x.changed_at)} · ${x.changed_by || 'system'}`))))
          : h('div', { class: 'muted small' }, 'No stage changes recorded.')),
      card('Attendance record', h('div', {},
        h('div', { style: { marginBottom: '12px' } },
          h('div', { class: 'small muted' }, 'Overall attendance'),
          h('div', { style: { fontSize: '26px', fontWeight: '700' } },
            s.attendance.percent == null ? '—' : `${s.attendance.percent}%`),
          h('div', { class: 'small muted' }, `${s.attendance.present || 0} present of ${s.attendance.total || 0} marked sessions`)),
        progressBar(s.attendance.percent || 0),
        h('a', { href: '#/attendance', class: 'btn sm', style: { marginTop: '14px' } }, 'Mark attendance →'))));
  }

  render();
  return host;
}
