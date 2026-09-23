import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, debounce, clear, loading, statTile, progressBar, batchText, todayStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';

export default async function batches({ params, query, state }) {
  return params.id ? detail(params.id, state) : list(query, state);
}

/* ------------------------------------------------------------- list */
async function list(query, state) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  // No status key here on purpose. The control for it is gone, so reading it
  // from the URL would apply a filter with nothing on screen to explain it and
  // no way to clear it.
  const filters = {
    q: query.q || '', course_id: query.course_id || '',
    trainer_id: query.trainer_id || '',
  };

  async function load() {
    clear(tableHost).appendChild(loading());
    const rows = await api.get('/api/batches', filters);
    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, `${rows.length} batch${rows.length === 1 ? '' : 'es'}`),
          h('div', { class: 'sub' }, 'Ongoing batches first, then upcoming'))),
      dataTable({
        columns: [
          {
            // the code is the batch number the office works from
            key: 'code', label: 'Batch', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.code),
              h('div', { class: 'small muted' }, r.course_name)),
          },
          { key: 'trainer_name', label: 'Trainer' },
          {
            key: 'start_date', label: 'Schedule', render: (r) => h('div', {},
              h('div', { class: 'small' }, `${fmt.dateShort(r.start_date)} → ${fmt.dateShort(r.end_date)}`),
              h('div', { class: 'small muted' }, `${r.days || '—'} · ${r.time_slot || '—'}`)),
          },
          { key: 'mode', label: 'Mode', render: (r) => badge(r.mode, 'navy') },
          {
            key: 'filled', label: 'Seats', align: 'right', render: (r) => h('div', {},
              h('div', { class: 'small mono' }, `${r.filled} / ${r.capacity}`),
              progressBar((r.filled / Math.max(1, r.capacity)) * 100)),
          },
          { key: 'room', label: 'Room' },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
        ],
        rows,
        onRow: (r) => navigate(`/batches/${r.id}`),
        empty: 'No batches match these filters',
        emptyHint: 'Create a batch to schedule a course and take attendance.',
      }),
      h('div', { class: 'export-bar' },
        h('button', { class: 'btn sm', onClick: () => api.download('/api/batches/export') }, '↓ Export CSV'))));
  }

  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Batch code, course, room' },
    {
      name: 'course_id', label: 'Course', type: 'select', placeholder: 'All courses',
      options: meta.lookups.courses.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      name: 'trainer_id', label: 'Trainer', type: 'select', placeholder: 'All trainers',
      options: meta.lookups.staff.map((s) => ({ value: s.id, label: s.name })),
    },
  ], filters);

  const apply = () => {
    Object.assign(filters, form.read());
    // setQuery merges into whatever is already in the hash, so blank this out
    // explicitly — otherwise an old bookmarked ?status=… would sit in the
    // address bar forever, looking like a filter that is no longer applied.
    setQuery({ ...filters, status: '' });
    load();
  };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Batches', 'Schedules, trainers, rosters and seat capacity', [
    h('button', { class: 'btn primary', onClick: () => batchModal(state, null, (b) => navigate(`/batches/${b.id}`)) }, '+ New batch'),
  ]));
  host.appendChild(form.el);
  host.appendChild(tableHost);
  await load();
  return host;
}

/* ----------------------------------------------------------- detail */
async function detail(id, state) {
  const host = h('div', {});
  let b = await api.get(`/api/batches/${id}`);
  let summary = null;
  try { summary = await api.get('/api/attendance/summary', { batch_id: id }); } catch (_) { /* optional */ }

  const reload = async () => {
    b = await api.get(`/api/batches/${id}`);
    try { summary = await api.get('/api/attendance/summary', { batch_id: id }); } catch (_) { summary = null; }
    render();
  };

  function render() {
    clear(host);
    const attendanceByStudent = Object.fromEntries(
      ((summary && summary.rows) || []).map((r) => [r.student_id, r]),
    );

    host.appendChild(pageHead(
      b.code,
      `${b.course_name} · ${b.trainer_name || 'No trainer assigned'}`, [
      h('a', { class: 'btn', href: '#/batches' }, '← All batches'),
      h('button', { class: 'btn', onClick: () => api.download('/api/attendance/export', { batch_id: b.id }) }, '↓ Attendance CSV'),
      h('button', { class: 'btn navy', onClick: () => navigate(`/attendance?batch_id=${b.id}`) }, '☑ Mark attendance'),
      h('button', { class: 'btn primary', onClick: () => batchModal(state, b, reload) }, '✎ Edit batch'),
    ]));

    host.appendChild(h('div', { class: 'tiles' },
      statTile({
        label: 'Seats filled', value: `${b.filled} / ${b.capacity}`,
        tone: b.seats_left === 0 ? 'warn' : 'good', sub: `${b.seats_left} seat(s) left`,
      }),
      statTile({ label: 'Status', value: b.status, sub: `${b.mode} · ${b.room || 'no room set'}` }),
      statTile({
        label: 'Runs', value: `${fmt.dateShort(b.start_date)} → ${fmt.dateShort(b.end_date)}`,
        sub: `${b.days || 'days not set'} · ${b.time_slot || 'time not set'}`,
      }),
      statTile({
        label: 'Sessions held', value: summary ? fmt.num(summary.sessions_held) : '—',
        sub: `${b.sessions.length} planned session(s)`,
      })));

    const roster = card('Roster', dataTable({
      columns: [
        {
          key: 'name', label: 'Student', render: (r) => h('div', {},
            h('div', { class: 'strong' }, r.name),
            h('div', { class: 'small muted' }, `${r.reg_no} · ${r.phone}`)),
        },
        { key: 'stage', label: 'Stage', render: (r) => badge(r.stage) },
        { key: 'enrollment_status', label: 'Enrollment', render: (r) => badge(r.enrollment_status) },
        {
          key: 'attendance', label: 'Attendance', align: 'right', render: (r) => {
            const a = attendanceByStudent[r.student_id];
            if (!a || a.percent == null) return h('span', { class: 'muted' }, '—');
            return h('div', {},
              h('div', { class: 'small mono' }, `${a.percent}%`),
              progressBar(a.percent));
          },
        },
        { key: 'net_fee', label: 'Fee', align: 'right', render: (r) => fmt.money(r.net_fee) },
        { key: 'paid', label: 'Paid', align: 'right', render: (r) => fmt.money(r.paid) },
        {
          key: 'balance', label: 'Balance', align: 'right',
          render: (r) => h('span', { class: r.net_fee - r.paid > 0 ? 'money-neg' : 'money-pos' },
            fmt.money(r.net_fee - r.paid)),
        },
      ],
      rows: b.roster,
      onRow: (r) => navigate(`/students/${r.student_id}`),
      footer: b.roster.length ? {
        name: `${b.roster.length} student(s)`,
        net_fee: fmt.money(b.roster.reduce((s, r) => s + r.net_fee, 0)),
        paid: fmt.money(b.roster.reduce((s, r) => s + r.paid, 0)),
        balance: fmt.money(b.roster.reduce((s, r) => s + (r.net_fee - r.paid), 0)),
      } : null,
      empty: 'No students in this batch yet',
      emptyHint: 'Enroll students into this batch from their student page.',
    }), { flush: true });

    const sessions = card('Session calendar',
      b.sessions.length
        ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          b.sessions.map((d) => {
            const held = summary && summary.dates.includes(d);
            const past = d <= todayStr();
            return h('span', {
              class: `badge ${held ? 'good' : past ? 'warn' : ''}`,
              title: held ? 'Attendance marked' : past ? 'Attendance not marked' : 'Upcoming',
            }, fmt.dateShort(d));
          }))
        : h('div', { class: 'muted small' }, 'Set a start date, end date and days to generate the calendar.'),
      { sub: 'Green = attendance marked, amber = missed, plain = upcoming' });

    const about = card('Batch details', h('div', {},
      h('dl', { class: 'kv' },
        h('dt', {}, 'Course'), h('dd', {}, `${b.course_name} (${b.course_code})`),
        h('dt', {}, 'Trainer'), h('dd', {}, b.trainer_name || '—'),
        h('dt', {}, 'Mode'), h('dd', {}, b.mode),
        h('dt', {}, 'Days'), h('dd', {}, b.days || '—'),
        h('dt', {}, 'Time'), h('dd', {}, b.time_slot || '—'),
        h('dt', {}, 'Room'), h('dd', {}, b.room || '—'),
        h('dt', {}, 'Capacity'), h('dd', {}, String(b.capacity)),
        h('dt', {}, 'Notes'), h('dd', {}, b.notes || '—')),
      h('button', { class: 'btn danger sm', style: { marginTop: '16px' }, onClick: remove }, 'Delete batch')));

    host.appendChild(h('div', { class: 'grid s21', style: { marginBottom: '14px' } }, roster, about));
    host.appendChild(sessions);
  }

  async function remove() {
    const go = await confirmDialog({
      title: 'Delete batch',
      message: b.filled
        ? `${b.filled} student(s) are enrolled in ${b.code}. Move them to another batch first, or set the status to Cancelled.`
        : `Delete ${b.code}?`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!go) return;
    try {
      await api.del(`/api/batches/${b.id}`);
      toast('Batch deleted', 'good');
      navigate('/batches');
    } catch (err) { toast(err.message, 'danger', 7000); }
  }

  render();
  return host;
}

/* ------------------------------------------------------------ modal */
export function batchModal(state, batch, onSaved) {
  const meta = state.meta;
  formModal({
    title: batch ? `Edit ${batch.code}` : 'New batch',
    size: 'wide',
    fields: [
      {
        name: 'code', label: 'Batch code', required: true, placeholder: 'DA-101-2026A',
        hint: 'Any format you like — DA-101-2026A, 13Jul2026, Morning Batch 3. Saved exactly as typed.',
      },
      {
        name: 'course_id', label: 'Course', type: 'select', required: true, placeholder: 'Choose a course',
        options: meta.lookups.courses.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })),
      },
      {
        name: 'trainer_id', label: 'Trainer', type: 'select', placeholder: 'Assign later',
        options: meta.lookups.staff.map((s) => ({ value: s.id, label: `${s.name}${s.designation ? ` · ${s.designation}` : ''}` })),
      },
      { name: 'mode', label: 'Mode', type: 'select', options: meta.enums.modes, required: true },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'end_date', label: 'End date', type: 'date' },
      { name: 'days', label: 'Class days', type: 'checklist', options: meta.enums.days, span: true },
      { name: 'time_slot', label: 'Time slot', placeholder: '10:00 - 12:00' },
      { name: 'room', label: 'Room / link', placeholder: 'Lab 2 or a meeting link' },
      { name: 'capacity', label: 'Capacity', type: 'number', min: '1', required: true },
      { name: 'status', label: 'Status', type: 'select', options: meta.enums.batch_status, required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 2 },
    ],
    values: batch || { mode: 'Offline', capacity: 25, status: 'Planned', days: 'Mon,Wed,Fri' },
    submitLabel: batch ? 'Save changes' : 'Create batch',
    async onSubmit(v, ctl) {
      const saved = batch
        ? await api.put(`/api/batches/${batch.id}`, v)
        : await api.post('/api/batches', v);
      ctl.close();
      toast(batch ? 'Batch updated' : 'Batch created', 'good');
      await state.refreshMeta();
      if (onSaved) onSaved(saved);
    },
  });
}
