import { api } from '../api.js';
import {
  h, fmt, pageHead, dataTable, badge, buildForm, debounce, clear, loading,
  statTile, progressBar, toast, confirmDialog, formModal, batchBadge, batchText,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';
import { enrollmentModal, paymentModal } from './shared-forms.js';

export default async function enrollments({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  const tileHost = h('div', { class: 'tiles' });

  // No status key here on purpose. The control for it is gone, so reading it
  // from the URL would apply a filter with nothing on screen to explain it and
  // no way to clear it.
  const filters = {
    q: query.q || '', course_id: query.course_id || '',
    batch_id: query.batch_id || '', unassigned: query.unassigned || '',
    from: query.from || '', to: query.to || '',
  };

  const exportBtn = () => h('button', {
    class: 'btn sm',
    onClick: () => api.download('/api/enrollments/export', { from: filters.from, to: filters.to }),
  }, '↓ Export CSV');

  /**
   * Enrolled-date range. The button doubles as the indicator — once a range is
   * set it spells it out, so an active filter is never hidden behind a dialog.
   */
  function filterSummary() {
    const { from, to } = filters;
    if (!from && !to) return null;
    if (from && to) return `Enrolled ${fmt.dateShort(from)} → ${fmt.dateShort(to)}`;
    return from ? `Enrolled from ${fmt.dateShort(from)}` : `Enrolled up to ${fmt.dateShort(to)}`;
  }

  function paintFilterBtn() {
    const summary = filterSummary();
    filterBtn.textContent = summary ? `▤ ${summary}` : '▤ Filter';
    filterBtn.classList.toggle('navy', !!summary);
  }

  function filterDialog() {
    const applyFilter = (from, to) => {
      filters.from = from;
      filters.to = to;
      setQuery(filters);
      paintFilterBtn();
      load();
    };

    const ctl = formModal({
      title: 'Filter enrollments',
      size: 'narrow',
      fields: [
        {
          name: 'from', label: 'Enrolled from (start date)', type: 'date', span: true,
          hint: 'Both ends are included. Leave one blank for an open-ended range.',
        },
        { name: 'to', label: 'Enrolled up to (end date)', type: 'date', span: true },
      ],
      values: { from: filters.from, to: filters.to },
      submitLabel: 'Apply',
      extraFooter: h('button', {
        class: 'btn',
        onClick: () => { ctl.close(); applyFilter('', ''); toast('Filter cleared', 'good'); },
      }, 'Clear'),
      async onSubmit(v, c, form2) {
        if (!v.from && !v.to) {
          form2.setErrors({ from: 'Give a start date, an end date, or both' });
          return;
        }
        if (v.from && v.to && v.from > v.to) {
          form2.setErrors({ to: 'The end date is before the start date' });
          return;
        }
        c.close();
        applyFilter(v.from || '', v.to || '');
      },
    });
  }

  async function load() {
    clear(tableHost).appendChild(loading());
    const data = await api.get('/api/enrollments', filters);
    const t = data.rows.reduce((a, r) => ({
      billed: a.billed + r.net_fee, paid: a.paid + r.paid, bal: a.bal + r.balance,
    }), { billed: 0, paid: 0, bal: 0 });

    clear(tileHost).appendChild(h('div', { style: { display: 'contents' } },
      statTile({ label: 'Enrollments', value: fmt.num(data.rows.length) }),
      statTile({ label: 'Billed', value: fmt.money(t.billed) }),
      statTile({ label: 'Collected', value: fmt.money(t.paid), tone: 'good' }),
      statTile({ label: 'Balance', value: fmt.money(t.bal), tone: t.bal > 0 ? 'warn' : 'good' })));

    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, 'All enrollments'),
          h('div', { class: 'sub' },
            filterSummary()
              ? `${filterSummary()} · a student can hold more than one enrollment`
              : 'A student can hold more than one enrollment'))),
      dataTable({
        columns: [
          {
            key: 'student_name', label: 'Student', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.student_name),
              h('div', { class: 'small muted' }, `${r.reg_no} · ${r.phone}`)),
          },
          { key: 'course_name', label: 'Course' },
          {
            key: 'batch_code', label: 'Batch',
            render: (r) => batchBadge(r.batch_start, r.batch_code),
          },
          { key: 'enrolled_on', label: 'Enrolled', render: (r) => h('span', { class: 'small' }, fmt.date(r.enrolled_on)) },
          { key: 'net_fee', label: 'Fee', align: 'right', render: (r) => fmt.money(r.net_fee) },
          {
            key: 'paid', label: 'Collected', align: 'right', render: (r) => h('div', {},
              h('div', {}, fmt.money(r.paid)),
              progressBar(r.net_fee ? (r.paid / r.net_fee) * 100 : 0)),
          },
          {
            key: 'balance', label: 'Balance', align: 'right',
            render: (r) => h('span', { class: r.balance > 0 ? 'money-neg' : 'money-pos' }, fmt.money(r.balance)),
          },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => edit(r) }, '✎'),
              r.balance > 0
                ? h('button', { class: 'btn sm primary', onClick: () => collect(r) }, '₹')
                : null),
          },
        ],
        rows: data.rows,
        onRow: (r) => navigate(`/students/${r.student_id}`),
        // export rides in the totals row rather than taking a row of its own
        footer: data.rows.length
          ? {
            student_name: `${data.rows.length} enrollment(s)`,
            net_fee: fmt.money(t.billed),
            paid: fmt.money(t.paid),
            balance: fmt.money(t.bal),
            actions: exportBtn(),
          }
          : null,
        empty: 'No enrollments match these filters',
        emptyHint: 'Enroll a student from their profile, or use the button above.',
      }),
      // nothing to total when the table is empty, so the button needs its own row
      data.rows.length ? null : h('div', { class: 'export-bar' }, exportBtn())));
  }

  async function edit(r) {
    // the student list comes too, so a wrong student can be corrected here
    const [full, roster] = await Promise.all([
      api.get(`/api/enrollments/${r.id}`),
      api.get('/api/students', { limit: 500, sort: 'name' }),
    ]);
    enrollmentModal({ meta, enrollment: full, students: roster.rows, onSaved: load });
  }

  async function collect(r) {
    const s = await api.get(`/api/students/${r.student_id}`);
    paymentModal({ meta, student: s, enrollments: s.enrollments, preselect: r.id, onSaved: load });
  }

  async function create() {
    const { rows } = await api.get('/api/students', { limit: 500, sort: 'name' });
    if (!rows.length) {
      toast('Add a student first, then enroll them into a course.', 'warn');
      return;
    }
    enrollmentModal({ meta, students: rows, onSaved: load });
  }

  // sits in the bar with the other filters rather than up in the page head
  const filterBtn = h('button', { class: 'btn', onClick: () => filterDialog() });
  paintFilterBtn();

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
    { type: 'node', node: filterBtn },
    { name: 'unassigned', label: 'Only without a batch', type: 'checkbox' },
  ], { ...filters, unassigned: filters.unassigned === '1' });

  const apply = () => {
    const v = form.read();
    Object.assign(filters, { ...v, unassigned: v.unassigned ? '1' : '' });
    // setQuery merges into whatever is already in the hash, so blank this out
    // explicitly — otherwise an old bookmarked ?status=… would sit in the
    // address bar forever, looking like a filter that is no longer applied.
    setQuery({ ...filters, status: '' });
    load();
  };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Enrollments', 'Which student is on which course, and what they owe', [
    h('button', { class: 'btn primary', onClick: create }, '+ New enrollment'),
  ]));
  host.appendChild(tileHost);
  host.appendChild(form.el);
  host.appendChild(tableHost);
  await load();
  return host;
}
