import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, debounce, clear, loading, statTile, todayStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';
import { rankedBars } from '../charts.js';

export default async function placements({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  const tileHost = h('div', { class: 'tiles' });
  const chartHost = h('div', { style: { marginTop: '14px' } });

  const filters = { q: query.q || '', status: query.status || '' };

  async function load() {
    clear(tableHost).appendChild(loading());
    const [data, stats] = await Promise.all([
      api.get('/api/placements', filters),
      api.get('/api/placements/stats/summary'),
    ]);

    clear(tileHost).appendChild(h('div', { style: { display: 'contents' } },
      statTile({ label: 'Students placed', value: fmt.num(stats.placed), tone: 'good', sub: `${stats.placement_rate}% of eligible students` }),
      statTile({ label: 'Offers made', value: fmt.num(data.stats.offered), sub: `${data.stats.total} application(s) tracked` }),
      statTile({ label: 'Average package', value: data.stats.avg_package ? `${data.stats.avg_package} LPA` : '—' }),
      statTile({ label: 'Highest package', value: data.stats.highest_package ? `${data.stats.highest_package} LPA` : '—', tone: 'accent' })));

    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, 'Placement activity'),
          h('div', { class: 'sub' }, 'Applications, interviews and offers'))),
      dataTable({
        columns: [
          {
            key: 'student_name', label: 'Student', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.student_name),
              h('div', { class: 'small muted' }, `${r.reg_no}${r.course_name ? ` · ${r.course_name}` : ''}`)),
          },
          { key: 'company', label: 'Company', render: (r) => h('span', { class: 'strong' }, r.company) },
          { key: 'role', label: 'Role' },
          { key: 'package_lpa', label: 'Package', align: 'right', render: (r) => (r.package_lpa ? `${r.package_lpa} LPA` : '—') },
          { key: 'location', label: 'Location' },
          {
            key: 'dates', label: 'Timeline', render: (r) => h('div', { class: 'small muted' },
              [r.applied_on && `Applied ${fmt.dateShort(r.applied_on)}`,
                r.interview_on && `Interview ${fmt.dateShort(r.interview_on)}`,
                r.offer_date && `Offer ${fmt.dateShort(r.offer_date)}`]
                .filter(Boolean).join(' · ') || '—'),
          },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => modal(r) }, '✎'),
              h('button', { class: 'btn sm danger', onClick: () => remove(r) }, '×')),
          },
        ],
        rows: data.rows,
        onRow: (r) => navigate(`/students/${r.student_id}`),
        empty: 'No placement records yet',
        emptyHint: 'Log each application so the placement rate and average package stay accurate.',
      }),
      h('div', { class: 'export-bar' },
        h('button', { class: 'btn sm', onClick: () => api.download('/api/placements/export') }, '↓ Export CSV'))));

    clear(chartHost).appendChild(h('div', { class: 'grid c2' },
      card('Top recruiters', rankedBars({
        rows: stats.by_company.map((c) => ({
          label: c.company, value: c.applications, fill: c.joined, sub: `${c.joined} joined`,
        })),
        valueFormat: fmt.num, limit: 8,
      }), { sub: 'Bar length is applications · the solid part is how many joined' }),
      card('Pipeline by status', rankedBars({
        rows: stats.by_status.map((r) => ({ label: r.status, value: r.c })),
        valueFormat: fmt.num, colorIndex: 2, limit: 8,
      }))));
  }

  async function modal(p) {
    let studentOptions = [];
    if (!p) {
      const { rows } = await api.get('/api/students', { limit: 500, sort: 'name' });
      studentOptions = rows.map((s) => ({ value: s.id, label: `${s.name} — ${s.reg_no}` }));
    }

    formModal({
      title: p ? `Edit — ${p.company}` : 'Log placement activity',
      size: 'wide',
      fields: [
        p
          ? { name: 'student_label', label: 'Student', disabled: true, value: `${p.student_name} (${p.reg_no})` }
          : {
            name: 'student_id', label: 'Student', type: 'select', required: true,
            placeholder: 'Choose a student', options: studentOptions,
          },
        { name: 'company', label: 'Company', required: true },
        { name: 'role', label: 'Role' },
        { name: 'package_lpa', label: 'Package (LPA)', type: 'number', step: '0.1', min: '0' },
        { name: 'location', label: 'Location' },
        { name: 'status', label: 'Status', type: 'select', options: meta.enums.placement_status, required: true },
        { name: 'applied_on', label: 'Applied on', type: 'date' },
        { name: 'interview_on', label: 'Interview on', type: 'date' },
        { name: 'offer_date', label: 'Offer date', type: 'date' },
        { name: 'joined_on', label: 'Joining date', type: 'date' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', span: true, rows: 2 },
      ],
      values: p || { status: 'Applied', applied_on: todayStr() },
      submitLabel: p ? 'Save changes' : 'Log activity',
      async onSubmit(v, ctl) {
        const payload = { ...v };
        delete payload.student_label;
        if (p) await api.put(`/api/placements/${p.id}`, payload);
        else await api.post('/api/placements', payload);
        ctl.close();
        toast(p ? 'Placement updated' : 'Placement logged', 'good');
        load();
      },
    });
  }

  async function remove(p) {
    const go = await confirmDialog({
      title: 'Delete record',
      message: `Delete the ${p.company} record for ${p.student_name}?`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!go) return;
    await api.del(`/api/placements/${p.id}`);
    toast('Record deleted', 'good');
    load();
  }

  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Company, role, student' },
    { name: 'status', label: 'Status', type: 'select', options: meta.enums.placement_status, placeholder: 'All statuses' },
  ], filters);

  const apply = () => { Object.assign(filters, form.read()); setQuery(filters); load(); };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Placements', 'The end of the journey — offers, packages and joiners', [
    h('button', { class: 'btn primary', onClick: () => modal() }, '+ Log activity'),
  ]));
  host.appendChild(tileHost);
  host.appendChild(form.el);
  host.appendChild(tableHost);
  host.appendChild(chartHost);
  await load();
  return host;
}
