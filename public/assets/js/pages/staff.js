import { api } from '../api.js';
import {
  h, fmt, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, debounce, clear, loading, openModal, todayStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';

export default async function staff({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  // No active key here on purpose. The control for it is gone, so reading it
  // from the URL would hide half the team with nothing on screen to say why.
  const filters = { q: query.q || '', designation: query.designation || '' };

  async function load() {
    clear(tableHost).appendChild(loading());
    const rows = await api.get('/api/staff', filters);
    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, `${rows.length} team member${rows.length === 1 ? '' : 's'}`))),
      dataTable({
        columns: [
          {
            key: 'name', label: 'Name', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.name),
              h('div', { class: 'small muted' }, [r.phone, r.email].filter(Boolean).join(' · ') || '—')),
          },
          { key: 'designation', label: 'Role', render: (r) => badge(r.designation || 'Staff', 'navy') },
          { key: 'specialization', label: 'Specialisation' },
          { key: 'batch_count', label: 'Batches', align: 'right', render: (r) => h('span', { class: 'mono' }, r.batch_count) },
          { key: 'ongoing_batches', label: 'Ongoing', align: 'right', render: (r) => h('span', { class: 'mono' }, r.ongoing_batches) },
          { key: 'join_date', label: 'Joined', align: 'right', render: (r) => h('span', { class: 'small' }, fmt.dateShort(r.join_date)) },
          { key: 'active', label: 'Status', render: (r) => badge(r.active ? 'Active' : 'Inactive', r.active ? 'good' : '') },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => open(r) }, 'View'),
              h('button', { class: 'btn sm', onClick: () => modal(r) }, '✎')),
          },
        ],
        rows,
        onRow: (r) => open(r),
        empty: 'No staff records yet',
        emptyHint: 'Add trainers so batches can be assigned, and counsellors so leads can be owned.',
      }),
      h('div', { class: 'export-bar' },
        h('button', { class: 'btn sm', onClick: () => api.download('/api/staff/export') }, '↓ Export CSV'))));
  }

  async function open(row) {
    const s = await api.get(`/api/staff/${row.id}`);
    let ctl;
    ctl = openModal({
      title: s.name,
      size: 'wide',
      body: h('div', {},
        h('div', { style: { display: 'flex', gap: '7px', marginBottom: '14px', flexWrap: 'wrap' } },
          badge(s.designation || 'Staff', 'navy'),
          badge(s.active ? 'Active' : 'Inactive', s.active ? 'good' : '')),
        h('dl', { class: 'kv', style: { marginBottom: '18px' } },
          h('dt', {}, 'Phone'), h('dd', {}, s.phone || '—'),
          h('dt', {}, 'Email'), h('dd', {}, s.email || '—'),
          h('dt', {}, 'Specialisation'), h('dd', {}, s.specialization || '—'),
          h('dt', {}, 'Joined'), h('dd', {}, s.join_date ? fmt.date(s.join_date) : '—'),
          h('dt', {}, 'Notes'), h('dd', {}, s.notes || '—')),
        h('h4', { style: { margin: '0 0 8px', fontSize: '13px' } }, `Batches (${s.batches.length})`),
        dataTable({
          columns: [
            { key: 'code', label: 'Batch' },
            { key: 'course_name', label: 'Course' },
            { key: 'start_date', label: 'Starts', render: (r) => fmt.date(r.start_date) },
            { key: 'students', label: 'Students', align: 'right' },
            { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          ],
          rows: s.batches,
          onRow: (r) => { ctl.close(); navigate(`/batches/${r.id}`); },
          empty: 'Not assigned to any batch',
        })),
      footer: [
        h('button', { class: 'btn danger', onClick: () => remove(s, ctl) }, 'Delete'),
        h('div', { style: { flex: '1' } }),
        h('button', { class: 'btn primary', onClick: () => { ctl.close(); modal(s); } }, '✎ Edit'),
      ],
    });
  }

  function modal(s) {
    formModal({
      title: s ? `Edit ${s.name}` : 'Add a team member',
      fields: [
        { name: 'name', label: 'Full name', required: true },
        { name: 'designation', label: 'Role', type: 'select', options: meta.enums.designations, required: true },
        { name: 'phone', label: 'Phone', type: 'tel' },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'specialization', label: 'Specialisation', span: true, placeholder: 'Python, Power BI, Admissions…' },
        { name: 'join_date', label: 'Joined on', type: 'date' },
        {
          /*
           * Spelled out rather than left as a tick box. "Currently working
           * with us" only ever stated one side — an unticked box reads as
           * something not filled in, not as a decision that someone has left.
           * The two words also match the badge on the list and the Status
           * filter above it, so one vocabulary covers the whole screen.
           */
          name: 'active',
          label: 'Status',
          type: 'select',
          required: true,
          options: [{ value: 1, label: 'Active' }, { value: 0, label: 'Inactive' }],
          hint: 'Inactive keeps the record and their history, but takes them out of the pickers.',
        },
        { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 2 },
      ],
      values: s || { active: 1, designation: 'Trainer', join_date: todayStr() },
      submitLabel: s ? 'Save changes' : 'Add member',
      async onSubmit(v, ctl) {
        if (s) await api.put(`/api/staff/${s.id}`, v);
        else await api.post('/api/staff', v);
        ctl.close();
        toast(s ? 'Staff member updated' : 'Staff member added', 'good');
        await state.refreshMeta();
        load();
      },
    });
  }

  async function remove(s, ctl) {
    const go = await confirmDialog({
      title: 'Delete staff member',
      message: `Delete ${s.name}? People assigned to batches cannot be deleted — mark them inactive instead.`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!go) return;
    try {
      await api.del(`/api/staff/${s.id}`);
      if (ctl) ctl.close();
      toast('Staff member deleted', 'good');
      await state.refreshMeta();
      load();
    } catch (err) { toast(err.message, 'danger', 7000); }
  }

  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Name, phone, specialisation' },
    { name: 'designation', label: 'Role', type: 'select', options: meta.enums.designations, placeholder: 'All roles' },
  ], filters);

  const apply = () => {
    Object.assign(filters, form.read());
    // setQuery merges into whatever is already in the hash, so blank this out
    // explicitly — otherwise an old bookmarked ?active=0 would sit in the
    // address bar forever, hiding most of the team with nothing on screen to
    // explain it. Active and inactive are told apart by the Status badge.
    setQuery({ ...filters, active: '' });
    load();
  };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Staff & trainers', 'Who teaches what, and who owns which leads', [
    h('button', { class: 'btn primary', onClick: () => modal() }, '+ Add member'),
  ]));
  host.appendChild(form.el);
  host.appendChild(tableHost);
  await load();
  return host;
}
