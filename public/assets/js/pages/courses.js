import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, debounce, clear, loading, statTile,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';
import { feePlanModal } from './fees.js';

export default async function courses({ params, query, state }) {
  return params.id ? detail(params.id, state) : list(query, state);
}

/* ------------------------------------------------------------- list */
async function list(query, state) {
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  // Search already matches on category, so it gets no box of its own
  // No active key here on purpose. The control for it is gone, so reading it
  // from the URL would hide the catalogue with nothing on screen to say why.
  const filters = { q: query.q || '' };

  async function load() {
    clear(tableHost).appendChild(loading());
    const rows = await api.get('/api/courses', filters);
    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, `${rows.length} course${rows.length === 1 ? '' : 's'}`))),
      dataTable({
        columns: [
          {
            key: 'name', label: 'Course', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.name),
              h('div', { class: 'small muted' }, `${r.code}${r.category ? ` · ${r.category}` : ''}`)),
          },
          { key: 'mode', label: 'Mode', render: (r) => badge(r.mode, 'navy') },
          {
            key: 'duration_weeks', label: 'Duration', render: (r) => h('span', { class: 'small' },
              `${r.duration_weeks || 0} weeks · ${r.total_hours || 0} hrs`),
          },
          {
            // the rate each course charges, since it is set per course
            key: 'base_fee', label: 'Base fee', align: 'right', render: (r) => h('div', {},
              h('div', {}, fmt.money(r.base_fee)),
              h('div', { class: 'small muted' }, r.tax_percent
                ? `+${r.tax_percent}% GST = ${fmt.money(r.base_fee * (1 + r.tax_percent / 100))}`
                : 'No GST')),
          },
          { key: 'plan_count', label: 'Fee plans', align: 'right', render: (r) => h('span', { class: 'mono' }, r.plan_count) },
          { key: 'batch_count', label: 'Batches', align: 'right', render: (r) => h('span', { class: 'mono' }, r.batch_count) },
          { key: 'active_students', label: 'Active', align: 'right', render: (r) => h('span', { class: 'mono' }, r.active_students) },
          { key: 'active', label: 'Status', render: (r) => badge(r.active ? 'Active' : 'Inactive', r.active ? 'good' : '') },
        ],
        rows,
        onRow: (r) => navigate(`/courses/${r.id}`),
        empty: 'No courses yet',
        emptyHint: 'A course holds the syllabus, base fee and its fee plans.',
      }),
      // export sits below the table, bottom-right, out of the heading's way
      h('div', { class: 'export-bar' },
        h('button', { class: 'btn sm', onClick: () => api.download('/api/courses/export') }, '↓ Export CSV'))));
  }

  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Name, code, category' },
  ], filters);

  const apply = () => {
    Object.assign(filters, form.read());
    // setQuery merges into whatever is already in the hash, so blank this out
    // explicitly — otherwise an old bookmarked ?active=0 would sit in the
    // address bar forever, hiding the live catalogue with nothing on screen to
    // explain it. The Status badge tells the two apart.
    setQuery({ ...filters, active: '' });
    load();
  };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Courses', 'Your catalogue, syllabus and fee structure', [
    h('button', { class: 'btn primary', onClick: () => courseModal(state, null, (c) => navigate(`/courses/${c.id}`)) }, '+ New course'),
  ]));
  host.appendChild(form.el);
  host.appendChild(tableHost);
  await load();
  return host;
}

/* ----------------------------------------------------------- detail */
async function detail(id, state) {
  const host = h('div', {});
  let c = await api.get(`/api/courses/${id}`);
  const reload = async () => { c = await api.get(`/api/courses/${id}`); render(); };

  function render() {
    clear(host);
    host.appendChild(pageHead(c.name, `${c.code}${c.category ? ` · ${c.category}` : ''} · ${c.mode}`, [
      h('a', { class: 'btn', href: '#/courses' }, '← All courses'),
      h('button', { class: 'btn', onClick: () => courseModal(state, c, reload) }, '✎ Edit course'),
      h('button', { class: 'btn navy', onClick: () => moduleModal() }, '+ Add module'),
      h('button', { class: 'btn primary', onClick: () => feePlanModal({ state, course: c, onSaved: reload }) }, '+ Fee plan'),
    ]));

    host.appendChild(h('div', { class: 'tiles' },
      statTile({ label: 'Base fee', value: fmt.money(c.base_fee), sub: c.tax_percent ? `+${c.tax_percent}% GST` : 'No GST' }),
      statTile({ label: 'Enrolled', value: fmt.num(c.stats.enrolled), tone: 'good', sub: `${c.stats.active} active now` }),
      statTile({ label: 'Batches', value: fmt.num(c.stats.batches) }),
      statTile({ label: 'Collected', value: fmt.money(c.stats.revenue), tone: 'accent' })));

    const syllabus = card('Syllabus', dataTable({
      columns: [
        { key: 'sequence', label: '#', width: '48px', align: 'right' },
        { key: 'title', label: 'Module', render: (r) => h('div', {},
          h('div', { class: 'strong' }, r.title),
          r.outline ? h('div', { class: 'small muted' }, r.outline) : null) },
        { key: 'hours', label: 'Hours', align: 'right', render: (r) => h('span', { class: 'mono' }, r.hours || '—') },
        {
          key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
            h('button', { class: 'btn sm', onClick: () => moduleModal(r) }, '✎'),
            h('button', { class: 'btn sm danger', onClick: () => removeModule(r) }, '×')),
        },
      ],
      rows: c.modules,
      empty: 'No modules added',
      emptyHint: 'List the topics so counsellors can explain the course confidently.',
      footer: c.modules.length
        ? { title: `${c.modules.length} module(s)`, hours: c.modules.reduce((s, m) => s + (m.hours || 0), 0) }
        : null,
    }), { flush: true });

    const plans = card('Fee plans', dataTable({
      columns: [
        { key: 'name', label: 'Plan', render: (r) => h('span', { class: 'strong' }, r.name) },
        { key: 'total_fee', label: 'Total', align: 'right', render: (r) => fmt.money(r.total_fee) },
        { key: 'item_count', label: 'Instalments', align: 'right', render: (r) => h('span', { class: 'mono' }, r.item_count) },
        { key: 'in_use', label: 'In use by', align: 'right', render: (r) => h('span', { class: 'mono' }, r.in_use) },
        { key: 'active', label: 'Status', render: (r) => badge(r.active ? 'Active' : 'Inactive', r.active ? 'good' : '') },
        {
          key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
            h('button', { class: 'btn sm', onClick: () => feePlanModal({ state, course: c, plan: r, onSaved: reload }) }, '✎')),
        },
      ],
      rows: c.fee_plans,
      empty: 'No fee plans yet',
      emptyHint: 'A fee plan defines the instalment schedule students are billed on.',
    }), { flush: true });

    const about = card('About this course', h('div', {},
      h('dl', { class: 'kv' },
        h('dt', {}, 'Code'), h('dd', {}, c.code),
        h('dt', {}, 'Category'), h('dd', {}, c.category || '—'),
        h('dt', {}, 'Mode'), h('dd', {}, c.mode),
        h('dt', {}, 'Duration'), h('dd', {}, `${c.duration_weeks || 0} weeks · ${c.total_hours || 0} hours`),
        h('dt', {}, 'Base fee'), h('dd', {}, fmt.money(c.base_fee)),
        h('dt', {}, 'GST'), h('dd', {}, c.tax_percent ? `${c.tax_percent}%` : '—'),
        h('dt', {}, 'Status'), h('dd', {}, badge(c.active ? 'Active' : 'Inactive', c.active ? 'good' : ''))),
      c.description ? h('p', { class: 'small', style: { marginTop: '14px' } }, c.description) : null,
      h('button', {
        class: 'btn danger sm', style: { marginTop: '16px' }, onClick: removeCourse,
      }, 'Delete course')));

    host.appendChild(h('div', { class: 'grid s21', style: { marginBottom: '14px' } }, syllabus, about));
    host.appendChild(plans);
  }

  function moduleModal(m) {
    formModal({
      title: m ? 'Edit module' : 'Add a syllabus module',
      fields: [
        { name: 'sequence', label: 'Order', type: 'number', min: '1' },
        { name: 'hours', label: 'Hours', type: 'number', min: '0' },
        { name: 'title', label: 'Module title', required: true, span: true },
        { name: 'outline', label: 'Topics covered', type: 'textarea', span: true, rows: 3 },
      ],
      values: m || { sequence: c.modules.length + 1 },
      submitLabel: m ? 'Save' : 'Add module',
      async onSubmit(v, ctl) {
        if (m) await api.put(`/api/courses/${c.id}/modules/${m.id}`, v);
        else await api.post(`/api/courses/${c.id}/modules`, v);
        ctl.close();
        toast('Syllabus updated', 'good');
        reload();
      },
    });
  }

  async function removeModule(m) {
    const go = await confirmDialog({ title: 'Remove module', message: `Remove “${m.title}”?`, danger: true, confirmLabel: 'Remove' });
    if (!go) return;
    await api.del(`/api/courses/${c.id}/modules/${m.id}`);
    toast('Module removed', 'good');
    reload();
  }

  async function removeCourse() {
    const go = await confirmDialog({
      title: 'Delete course',
      message: `Delete ${c.name}? Courses with enrollments or batches cannot be deleted — mark them inactive instead.`,
      danger: true,
      confirmLabel: 'Delete course',
    });
    if (!go) return;
    try {
      await api.del(`/api/courses/${c.id}`);
      toast('Course deleted', 'good');
      navigate('/courses');
    } catch (err) {
      toast(err.message, 'danger', 7000);
    }
  }

  render();
  return host;
}

/* ------------------------------------------------------------ modal */
export function courseModal(state, course, onSaved) {
  formModal({
    title: course ? `Edit ${course.name}` : 'New course',
    size: 'wide',
    fields: [
      { name: 'code', label: 'Course code', required: true, placeholder: 'DA-101' },
      { name: 'name', label: 'Course name', required: true },
      { name: 'category', label: 'Category', placeholder: 'Analytics / Data Science' },
      { name: 'mode', label: 'Mode', type: 'select', options: state.meta.enums.modes, required: true },
      { name: 'duration_weeks', label: 'Duration (weeks)', type: 'number', min: '0' },
      { name: 'total_hours', label: 'Total hours', type: 'number', min: '0' },
      { name: 'base_fee', label: 'Base fee', type: 'money', required: true },
      {
        name: 'tax_percent', label: 'GST %', type: 'number', step: '0.01', min: '0',
        hint: 'Added on top of the fee. Set 0 for a zero-rated course.',
      },
      { name: 'description', label: 'Description', type: 'textarea', span: true, rows: 3 },
      { name: 'active', label: 'Course is active and can be sold', type: 'checkbox', span: true },
    ],
    values: course || {
      mode: 'Offline', active: 1,
      tax_percent: Number(state.meta.settings.default_tax_percent) || 0,
    },
    submitLabel: course ? 'Save changes' : 'Create course',
    async onSubmit(v, ctl) {
      const saved = course
        ? await api.put(`/api/courses/${course.id}`, v)
        : await api.post('/api/courses', v);
      ctl.close();
      toast(course ? 'Course updated' : 'Course created', 'good');
      await state.refreshMeta();
      if (onSaved) onSaved(saved);
    },
  });
}
