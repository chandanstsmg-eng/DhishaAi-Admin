import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, debounce, clear, loading, statTile, tabs, openModal, batchText, noLeadingZero,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';
import { paymentModal } from './shared-forms.js';

export default async function fees({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const bodyHost = h('div', {});
  let tab = query.tab || 'dues';

  const filters = {
    q: query.q || '',
    overdue: query.overdue || '',
    course_id: query.course_id || '',
    batch_id: query.batch_id || '',
  };

  const exportBtn = () => h('button', {
    class: 'btn sm', onClick: () => api.download('/api/fees/outstanding/export'),
  }, '↓ Export CSV');

  // -------------------------------------------------- outstanding
  async function loadDues() {
    clear(bodyHost).appendChild(loading());
    const data = await api.get('/api/fees/outstanding', filters);

    const form = buildForm([
      { name: 'q', label: 'Search', placeholder: 'Student name, reg. no, phone' },
      {
        name: 'course_id', label: 'Course', type: 'select', placeholder: 'All courses',
        options: meta.lookups.courses.map((c) => ({ value: c.id, label: c.name })),
      },
      {
        name: 'batch_id', label: 'Batch', type: 'select', placeholder: 'All batches',
        options: meta.lookups.batches.map((b) => ({
          value: b.id, label: `${b.code} · starts ${fmt.batch(b.start_date) || '—'}`,
        })),
      },
      { name: 'overdue', label: 'Only overdue', type: 'checkbox' },
    ], { ...filters, overdue: filters.overdue === '1' });

    const apply = () => {
      const v = form.read();
      Object.assign(filters, { ...v, overdue: v.overdue ? '1' : '' });
      setQuery({ ...filters, tab });
      loadDues();
    };
    form.el.addEventListener('change', apply);
    form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
    form.el.className = 'filters';

    clear(bodyHost).appendChild(h('div', {},
      h('div', { class: 'tiles' },
        statTile({ label: 'Total outstanding', value: fmt.money(data.totals.balance), tone: 'warn', sub: `${data.count} instalment(s)` }),
        statTile({ label: 'Overdue', value: fmt.money(data.totals.overdue), tone: data.totals.overdue > 0 ? 'danger' : 'good', sub: 'Past the due date' }),
        statTile({ label: 'Not yet due', value: fmt.money(data.totals.balance - data.totals.overdue), sub: 'Still within terms' })),
      form.el,
      card(null, [dataTable({
        columns: [
          {
            key: 'student_name', label: 'Student', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.student_name),
              h('div', { class: 'small muted' }, `${r.reg_no} · ${r.phone}`)),
          },
          {
            key: 'course_name', label: 'Course / batch', render: (r) => h('div', {},
              h('div', {}, r.course_name),
              h('div', { class: 'small muted', title: r.batch_code || '' },
                batchText(r.batch_start, r.batch_code) || 'No batch')),
          },
          { key: 'label', label: 'Instalment' },
          { key: 'due_date', label: 'Due on', render: (r) => fmt.date(r.due_date) },
          {
            // "How late", not "Age": the column answers how overdue a payment
            // is, and it is the wording the Unpaid fee by date report already
            // uses for the same figure.
            key: 'days_overdue', label: 'How late', render: (r) => (r.days_overdue > 0
              ? badge(`${r.days_overdue} days late`, r.days_overdue > 30 ? 'danger' : 'warn')
              : badge('Upcoming', 'info')),
          },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmt.money(r.amount) },
          { key: 'paid_amount', label: 'Paid', align: 'right', render: (r) => fmt.money(r.paid_amount) },
          { key: 'balance', label: 'Balance', align: 'right', render: (r) => h('span', { class: 'money-neg' }, fmt.money(r.balance)) },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm primary', onClick: () => collect(r) }, 'Collect')),
          },
        ],
        rows: data.rows,
        onRow: (r) => navigate(`/students/${r.student_id}`),
        // export rides in the totals row rather than taking a row of its own
        footer: data.rows.length
          ? { student_name: `${data.count} instalment(s)`, balance: fmt.money(data.totals.balance), actions: exportBtn() }
          : null,
        empty: 'Nothing outstanding',
        emptyHint: 'Every issued instalment has been settled.',
      }),
      // nothing to total when the table is empty, so the button needs its own row
      data.rows.length ? null : h('div', { class: 'export-bar' }, exportBtn()),
      ], { flush: true })));
  }

  async function collect(row) {
    const s = await api.get(`/api/students/${row.student_id}`);
    paymentModal({
      meta, student: s, enrollments: s.enrollments, preselect: row.enrollment_id,
      onSaved: () => loadDues(),
    });
  }

  // ---------------------------------------------------- fee plans
  async function loadPlans() {
    clear(bodyHost).appendChild(loading());
    const rows = await api.get('/api/fee-plans');
    const grouped = {};
    for (const r of rows) (grouped[r.course_name] = grouped[r.course_name] || []).push(r);

    clear(bodyHost).appendChild(h('div', {},
      h('div', { class: 'alert info', style: { marginBottom: '14px' } },
        h('span', { class: 'ico' }, 'ℹ'),
        h('div', {},
          h('b', {}, 'A fee plan is a template.'),
          ' When a student is enrolled the plan is copied into their own instalment schedule, ',
          'so editing a plan later never disturbs fees already issued.')),
      Object.keys(grouped).length
        ? h('div', { style: { display: 'grid', gap: '14px' } }, Object.entries(grouped).map(([courseName, plans]) =>
          card(courseName, dataTable({
            columns: [
              { key: 'name', label: 'Plan', render: (r) => h('span', { class: 'strong' }, r.name) },
              { key: 'total_fee', label: 'Total fee', align: 'right', render: (r) => fmt.money(r.total_fee) },
              { key: 'item_count', label: 'Instalments', align: 'right', render: (r) => h('span', { class: 'mono' }, r.item_count) },
              { key: 'tax_percent', label: 'GST', align: 'right', render: (r) => (r.tax_percent ? `${r.tax_percent}%` : '—') },
              { key: 'in_use', label: 'Used by', align: 'right', render: (r) => h('span', { class: 'mono' }, `${r.in_use} student(s)`) },
              { key: 'active', label: 'Status', render: (r) => badge(r.active ? 'Active' : 'Inactive', r.active ? 'good' : '') },
              {
                key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
                  h('button', { class: 'btn sm', onClick: () => viewPlan(r) }, 'View'),
                  h('button', { class: 'btn sm', onClick: () => feePlanModal({ state, plan: r, onSaved: loadPlans }) }, '✎'),
                  h('button', { class: 'btn sm danger', onClick: () => removePlan(r) }, '×')),
              },
            ],
            rows: plans,
            empty: 'No plans',
          }), { flush: true, sub: plans[0].course_code })))
        : card(null, h('div', { class: 'dt-empty' },
          h('div', { class: 'big' }, '◍'),
          h('div', {}, 'No fee plans defined yet'),
          h('div', { class: 'small muted', style: { marginTop: '6px' } },
            'Add a plan per course — for example “Pay in full” and “3 instalments”.')))));
  }

  async function viewPlan(p) {
    const plan = await api.get(`/api/fee-plans/${p.id}`);
    openModal({
      title: `${plan.name} — ${plan.course_name}`,
      body: dataTable({
        columns: [
          { key: 'sequence', label: '#', width: '44px', align: 'right' },
          { key: 'label', label: 'Instalment' },
          { key: 'due_offset_days', label: 'Due', render: (r) => (r.due_offset_days ? `${r.due_offset_days} days after joining` : 'At admission') },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmt.money(r.amount) },
        ],
        rows: plan.items,
        footer: { label: 'Total', amount: fmt.money(plan.items_total) },
        empty: 'No instalments defined',
      }),
      footer: [],
    });
  }

  async function removePlan(p) {
    const go = await confirmDialog({
      title: 'Delete fee plan',
      message: p.in_use
        ? `${p.in_use} enrollment(s) use this plan, so it cannot be deleted. Mark it inactive instead?`
        : `Delete the “${p.name}” plan?`,
      danger: true,
      confirmLabel: p.in_use ? 'Mark inactive' : 'Delete',
    });
    if (!go) return;
    try {
      if (p.in_use) await api.put(`/api/fee-plans/${p.id}`, { active: 0 });
      else await api.del(`/api/fee-plans/${p.id}`);
      toast(p.in_use ? 'Plan marked inactive' : 'Plan deleted', 'good');
      loadPlans();
    } catch (err) { toast(err.message, 'danger', 6000); }
  }

  // ------------------------------------------------------- chrome
  host.appendChild(pageHead('Fees & dues', 'Fee structure, instalment schedules and outstanding money', [
    h('button', { class: 'btn navy', onClick: () => navigate('/payments') }, '₹ Payments'),
    h('button', { class: 'btn primary', onClick: () => feePlanModal({ state, onSaved: () => { tab = 'plans'; loadPlans(); } }) }, '+ New fee plan'),
  ]));
  host.appendChild(tabs([
    { key: 'dues', label: 'Outstanding dues' },
    { key: 'plans', label: 'Fee plans' },
  ], tab, (k) => {
    tab = k;
    setQuery({ tab: k });
    host.querySelector('.tabs').replaceWith(rebuildTabs());
    k === 'dues' ? loadDues() : loadPlans();
  }));

  function rebuildTabs() {
    return tabs([
      { key: 'dues', label: 'Outstanding dues' },
      { key: 'plans', label: 'Fee plans' },
    ], tab, (k) => {
      tab = k;
      setQuery({ tab: k });
      host.querySelector('.tabs').replaceWith(rebuildTabs());
      k === 'dues' ? loadDues() : loadPlans();
    });
  }

  host.appendChild(bodyHost);
  await (tab === 'plans' ? loadPlans() : loadDues());
  return host;
}

/* --------------------------------------------------- fee plan modal */
/** Editor with a live instalment table that must add up to the total fee. */
export function feePlanModal({ state, course, plan, onSaved }) {
  const meta = state.meta;
  let items = plan
    ? null // loaded below
    : [{ label: 'Full payment', amount: 0, due_offset_days: 0 }];

  const itemsHost = h('div', {});
  const summary = h('div', { class: 'small', style: { marginTop: '8px' } });

  const drawItems = () => {
    clear(itemsHost);
    const table = h('table', { class: 'dt' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Label'), h('th', {}, 'Amount'),
        h('th', {}, 'Due (days after joining)'), h('th', {}))),
      h('tbody', {}, items.map((it, i) => h('tr', {},
        h('td', {}, h('input', {
          class: 'input', value: it.label,
          onInput: (e) => { items[i].label = e.target.value; },
        })),
        h('td', {}, noLeadingZero(h('input', {
          class: 'input', type: 'number', step: '0.01', placeholder: '0', value: it.amount || '',
          onInput: (e) => { items[i].amount = Number(e.target.value) || 0; updateSummary(); },
        }))),
        h('td', {}, noLeadingZero(h('input', {
          class: 'input', type: 'number', min: '0', placeholder: '0', value: it.due_offset_days || '',
          onInput: (e) => { items[i].due_offset_days = Number(e.target.value) || 0; },
        }))),
        h('td', { class: 'num' }, h('button', {
          class: 'btn sm danger', type: 'button',
          onClick: () => { items.splice(i, 1); drawItems(); },
        }, '×'))))));

    itemsHost.appendChild(h('div', { class: 'table-wrap' }, table));
    itemsHost.appendChild(h('div', { style: { display: 'flex', gap: '7px', marginTop: '9px', flexWrap: 'wrap' } },
      h('button', {
        class: 'btn sm', type: 'button',
        onClick: () => {
          items.push({ label: `Instalment ${items.length + 1}`, amount: 0, due_offset_days: items.length * 30 });
          drawItems();
        },
      }, '+ Add instalment'),
      h('button', { class: 'btn sm', type: 'button', onClick: () => splitEvenly(2) }, 'Split into 2'),
      h('button', { class: 'btn sm', type: 'button', onClick: () => splitEvenly(3) }, 'Split into 3'),
      h('button', { class: 'btn sm', type: 'button', onClick: () => splitEvenly(4) }, 'Split into 4')));
    itemsHost.appendChild(summary);
    updateSummary();
  };

  const splitEvenly = (n) => {
    const total = Number(ctl.form.controls.total_fee.input.value) || 0;
    const each = Math.round((total / n) * 100) / 100;
    items = Array.from({ length: n }, (_, i) => ({
      label: n === 1 ? 'Full payment' : (i === 0 ? 'Registration' : `Instalment ${i + 1}`),
      amount: i === n - 1 ? Math.round((total - each * (n - 1)) * 100) / 100 : each,
      due_offset_days: i * 30,
    }));
    drawItems();
  };

  const updateSummary = () => {
    const total = Number(ctl.form.controls.total_fee.input.value) || 0;
    const sum = Math.round(items.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100;
    const ok = Math.abs(sum - total) < 0.01;
    summary.replaceChildren(h('span', { style: { color: ok ? 'var(--good)' : 'var(--danger)', fontWeight: '650' } },
      ok ? `✓ Instalments add up to ${fmt.money(sum)}`
        : `Instalments total ${fmt.money(sum)} but the plan total is ${fmt.money(total)} — adjust before saving.`));
  };

  const ctl = formModal({
    title: plan ? `Edit “${plan.name}”` : 'New fee plan',
    size: 'wide',
    fields: [
      course
        ? { name: 'course_label', label: 'Course', disabled: true, value: course.name }
        : {
          name: 'course_id', label: 'Course', type: 'select', required: true, placeholder: 'Choose a course',
          options: meta.lookups.courses.map((c) => ({ value: c.id, label: c.name })),
        },
      { name: 'name', label: 'Plan name', required: true, placeholder: 'e.g. 3 instalments' },
      { name: 'total_fee', label: 'Total fee', type: 'money', required: true },
      {
        name: 'tax_percent', label: 'GST %', type: 'number', step: '0.01', min: '0',
        hint: 'Added on top of the total. Set 0 for a zero-rated plan.',
      },
      { name: 'notes', label: 'Notes', span: true },
      { name: 'active', label: 'Plan is active and can be assigned', type: 'checkbox', span: true },
      { type: 'section', label: 'Instalment schedule' },
      { type: 'node', span: true, node: itemsHost },
    ],
    values: plan
      ? { ...plan, course_id: plan.course_id }
      : {
        course_id: course ? course.id : '',
        total_fee: course ? course.base_fee : '',
        tax_percent: course && course.tax_percent != null
          ? course.tax_percent
          : Number(meta.settings.default_tax_percent) || 0,
        active: 1,
      },
    submitLabel: plan ? 'Save plan' : 'Create plan',
    async onSubmit(v, control) {
      const total = Number(v.total_fee) || 0;
      const sum = Math.round(items.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100;
      if (!items.length) { toast('Add at least one instalment', 'warn'); return; }
      if (Math.abs(sum - total) > 0.01) {
        toast(`Instalments add up to ${fmt.money(sum)} but the total fee is ${fmt.money(total)}.`, 'danger', 6000);
        return;
      }
      const payload = {
        ...v,
        course_id: course ? course.id : v.course_id,
        items: items.map((it, i) => ({ ...it, sequence: i + 1 })),
      };
      delete payload.course_label;
      if (plan) await api.put(`/api/fee-plans/${plan.id}`, payload);
      else await api.post('/api/fee-plans', payload);
      control.close();
      toast(plan ? 'Fee plan updated' : 'Fee plan created', 'good');
      await state.refreshMeta();
      if (onSaved) onSaved();
    },
  });

  ctl.form.controls.total_fee.input.addEventListener('input', updateSummary);

  if (plan) {
    api.get(`/api/fee-plans/${plan.id}`).then((full) => {
      items = full.items.map((i) => ({
        label: i.label, amount: i.amount, due_offset_days: i.due_offset_days,
      }));
      drawItems();
    });
    itemsHost.appendChild(h('div', { class: 'muted small' }, 'Loading instalments…'));
  } else {
    splitEvenly(1);
  }

  return ctl;
}
