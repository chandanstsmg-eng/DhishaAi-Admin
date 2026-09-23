import { api, ApiError } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, debounce, buildForm,
  confirmDialog, clear, loading, batchText, todayStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';

/** Field spec reused by the create and edit forms, and by student-detail. */
export function studentFields(meta) {
  return [
    { type: 'section', label: 'Personal' },
    { name: 'name', label: 'Full name', required: true },
    { name: 'phone', label: 'Phone', type: 'tel', required: true },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'alt_phone', label: 'Alternate phone', type: 'tel' },
    { name: 'dob', label: 'Date of birth', type: 'date' },
    { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'] },

    { type: 'section', label: 'Education' },
    { name: 'qualification', label: 'Qualification', placeholder: 'B.E / B.Sc / MCA' },
    { name: 'college', label: 'College' },
    { name: 'passout_year', label: 'Year of passing', placeholder: '2024' },
    { name: 'experience', label: 'Work experience', placeholder: 'Fresher / 2 years' },

    { type: 'section', label: 'Contact' },
    { name: 'address', label: 'Address', type: 'textarea', span: true, rows: 2 },
    { name: 'city', label: 'City' },
    { name: 'state', label: 'State' },
    { name: 'pincode', label: 'PIN code' },
    { name: 'guardian_name', label: 'Guardian name' },
    { name: 'guardian_phone', label: 'Guardian phone', type: 'tel' },

    { type: 'section', label: 'Admission' },
    { name: 'source', label: 'How did they hear about us?', type: 'select', options: meta.enums.sources },
    { name: 'joined_on', label: 'Joined on', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: meta.enums.student_status, required: true },
    { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 2 },
  ];
}

/** Opens the add/edit modal; resolves after a successful save. */
export function studentModal({ meta, student, onSaved }) {
  const editing = !!student;
  return formModal({
    title: editing ? `Edit ${student.name}` : 'Add a student',
    size: 'wide',
    fields: studentFields(meta),
    values: student || { status: 'Active', joined_on: todayStr() },
    submitLabel: editing ? 'Save changes' : 'Add student',
    async onSubmit(values, ctl) {
      try {
        const saved = editing
          ? await api.put(`/api/students/${student.id}`, values)
          : await api.post('/api/students', values);
        ctl.close();
        toast(editing ? 'Student updated' : `${saved.name} added as ${saved.reg_no}`, 'good');
        if (onSaved) onSaved(saved);
      } catch (err) {
        // A repeat phone number is a warning, not a hard stop.
        if (err instanceof ApiError && err.status === 409 && /already registered/.test(err.message)) {
          const go = await confirmDialog({
            title: 'Possible duplicate',
            message: `${err.message} Add this student anyway?`,
            confirmLabel: 'Add anyway',
          });
          if (!go) return;
          const saved = await api.post('/api/students', { ...values, allow_duplicate_phone: true });
          ctl.close();
          toast(`${saved.name} added as ${saved.reg_no}`, 'good');
          if (onSaved) onSaved(saved);
          return;
        }
        throw err;
      }
    },
  });
}

export default async function students({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card', style: { marginTop: '0' } });

  // No status/stage/source keys here on purpose. The controls for them are
  // gone, so reading them from the URL would apply a filter with nothing on
  // screen to explain it and no way to clear it.
  const filters = {
    q: query.q || '',
    course_id: query.course_id || '',
    dues: query.dues || '',
    sort: query.sort || 'created_at',
    from: query.from || '',
    to: query.to || '',
  };

  const exportBtn = () => h('button', {
    class: 'btn sm',
    onClick: () => api.download('/api/students/export', {
      from: filters.from, to: filters.to,
    }),
  }, '↓ Export CSV');

  /**
   * What the Filter dialog currently has applied, in words. The button doubles
   * as the indicator, so an active filter is never hidden behind a dialog.
   */
  function filterSummary() {
    const { from, to } = filters;
    if (from && to) return `Joined ${fmt.dateShort(from)} → ${fmt.dateShort(to)}`;
    if (from) return `Joined from ${fmt.dateShort(from)}`;
    if (to) return `Joined up to ${fmt.dateShort(to)}`;
    return null;
  }

  function paintFilterBtn() {
    const summary = filterSummary();
    filterBtn.textContent = summary ? `▤ ${summary}` : '▤ Filter';
    filterBtn.classList.toggle('navy', !!summary);
  }

  /**
   * A joined-date range, and nothing else. This used to be a two-way dialog —
   * date or status — but status filtering is gone from this screen, so the
   * "filter by" chooser had one option left and the form asks for the range
   * directly.
   */
  function filterDialog() {
    const applyFilter = (patch) => {
      Object.assign(filters, patch);
      setQuery(filters);
      paintFilterBtn();
      load();
    };

    const ctl = formModal({
      title: 'Filter students by joined date',
      size: 'narrow',
      fields: [
        {
          name: 'from', label: 'From (start date)', type: 'date', span: true,
          hint: 'Both ends are included. Leave one blank for an open-ended range.',
        },
        { name: 'to', label: 'To (end date)', type: 'date', span: true },
      ],
      values: { from: filters.from, to: filters.to },
      submitLabel: 'Apply',
      extraFooter: h('button', {
        class: 'btn',
        onClick: () => {
          ctl.close();
          applyFilter({ from: '', to: '' });
          toast('Filter cleared', 'good');
        },
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
        applyFilter({ from: v.from || '', to: v.to || '' });
      },
    });
  }

  async function load() {
    clear(tableHost).appendChild(loading());
    let data;
    try {
      data = await api.get('/api/students', { ...filters, limit: 300 });
    } catch (err) {
      clear(tableHost).appendChild(h('div', { class: 'dt-empty' }, err.message));
      return;
    }

    const totals = data.rows.reduce((a, r) => ({
      fee: a.fee + r.total_fee, paid: a.paid + r.total_paid, bal: a.bal + r.balance,
    }), { fee: 0, paid: 0, bal: 0 });

    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {},
          h('h3', {}, `${fmt.num(data.total)} student${data.total === 1 ? '' : 's'}`),
          h('div', { class: 'sub' },
            [
              filterSummary(),
              data.rows.length < data.total
                ? `showing the first ${data.rows.length} — narrow the filters to see the rest`
                : 'all matching records',
            ].filter(Boolean).join(' · ')))),
      dataTable({
        columns: [
          {
            key: 'name', label: 'Student', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.name),
              h('div', { class: 'small muted' }, `${r.reg_no} · ${r.phone}`)),
          },
          {
            key: 'courses', label: 'Course / batch', render: (r) => h('div', {},
              h('div', {}, r.courses || h('span', { class: 'muted' }, 'Not enrolled')),
              r.batch_code
                ? h('div', { class: 'small muted', title: r.batch_code },
                  batchText(r.batch_start, r.batch_code))
                : null),
          },
          { key: 'stage', label: 'Stage', render: (r) => badge(r.stage) },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          { key: 'total_fee', label: 'Fee', align: 'right', render: (r) => fmt.money(r.total_fee) },
          { key: 'total_paid', label: 'Paid', align: 'right', render: (r) => fmt.money(r.total_paid) },
          {
            key: 'balance', label: 'Balance', align: 'right', render: (r) => h('div', {},
              h('div', { class: r.balance > 0 ? 'money-neg' : 'money-pos' }, fmt.money(r.balance)),
              r.overdue_amount > 0
                ? badge(`${fmt.money(r.overdue_amount)} overdue`, 'danger') : null),
          },
          // No Pause column. It only ever set the status to On Hold, which the
          // Status column already shows and the student's own form already
          // sets — a whole column of buttons for one field on one form.
          { key: 'joined_on', label: 'Joined', align: 'right', render: (r) => h('span', { class: 'small' }, fmt.dateShort(r.joined_on)) },
        ],
        rows: data.rows,
        onRow: (r) => navigate(`/students/${r.id}`),
        // export rides in the totals row rather than taking a row of its own
        footer: data.rows.length ? {
          name: `${data.rows.length} shown`,
          total_fee: fmt.money(totals.fee),
          total_paid: fmt.money(totals.paid),
          balance: fmt.money(totals.bal),
          // the export sits in the last column, whichever that now is
          joined_on: exportBtn(),
        } : null,
        empty: filters.q || filters.course_id
          || filters.dues || filters.from || filters.to
          ? 'No students match these filters'
          : 'No students yet',
        emptyHint: 'Add your first student, or convert an enquiry from the Enquiries screen.',
      }),
      // nothing to total when the table is empty, so the button needs its own row
      data.rows.length ? null : h('div', { class: 'export-bar' }, exportBtn())));
  }

  // ------------------------------------------------------- filter bar
  // Lives in the bar rather than the page head: it is a filter, so it belongs
  // beside the other filters, on the same baseline as Sort by.
  const filterBtn = h('button', { class: 'btn', onClick: () => filterDialog() });
  paintFilterBtn();

  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Name, reg. no, phone, email, college' },
    {
      name: 'course_id', label: 'Course', type: 'select', placeholder: 'All courses',
      options: meta.lookups.courses.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      name: 'sort', label: 'Sort by', type: 'select', required: true,
      options: [
        { value: 'created_at', label: 'Newest first' },
        { value: 'name', label: 'Name (A–Z)' },
        { value: 'reg_no', label: 'Registration no.' },
        { value: 'balance', label: 'Highest balance' },
        { value: 'stage', label: 'Stage' },
      ],
    },
    { type: 'node', node: filterBtn },
    { name: 'dues', label: 'Only students with a balance', type: 'checkbox', span: true },
  ], { ...filters, dues: filters.dues === '1' });

  const apply = () => {
    const v = form.read();
    Object.assign(filters, { ...v, dues: v.dues ? '1' : '' });
    // setQuery merges into whatever is already in the hash, so blank these out
    // explicitly — otherwise an old bookmarked ?status=… would sit in the
    // address bar forever, looking like a filter that is no longer applied.
    setQuery({ ...filters, status: '', stage: '', source: '' });
    paintFilterBtn();
    load();
  };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Students', 'Every learner, their courses, fees and progress', [
    h('button', {
      class: 'btn primary',
      onClick: () => studentModal({ meta, onSaved: (s) => navigate(`/students/${s.id}`) }),
    }, '+ Add student'),
  ]));
  host.appendChild(form.el);
  host.appendChild(tableHost);

  await load();
  return host;
}
