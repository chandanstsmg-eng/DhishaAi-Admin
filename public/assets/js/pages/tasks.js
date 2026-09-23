import { api } from '../api.js';
import {
  h, fmt, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, clear, loading, statTile, todayStr,
} from '../ui.js';
import { setQuery } from '../router.js';

export default async function tasks({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  const tileHost = h('div', { class: 'tiles' });
  const filters = { status: query.status || 'Open', overdue: query.overdue || '' };

  async function load() {
    clear(tableHost).appendChild(loading());
    const data = await api.get('/api/tasks', filters);

    clear(tileHost).appendChild(h('div', { style: { display: 'contents' } },
      statTile({ label: 'Open tasks', value: fmt.num(data.open) }),
      statTile({ label: 'Overdue', value: fmt.num(data.overdue), tone: data.overdue ? 'danger' : 'good' }),
      statTile({ label: 'Showing', value: fmt.num(data.rows.length), sub: filters.status || 'All statuses' })));

    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, 'Task list'),
        h('div', { class: 'sub' }, 'Overdue and high-priority items float to the top'))),
      dataTable({
        columns: [
          {
            key: 'done', label: '', width: '40px', render: (r) => h('input', {
              type: 'checkbox', checked: r.status === 'Done',
              style: { width: '17px', height: '17px', accentColor: 'var(--orange)' },
              onChange: () => toggle(r),
            }),
          },
          {
            key: 'title', label: 'Task', render: (r) => h('div', {
              style: r.status === 'Done' ? { textDecoration: 'line-through', opacity: '.55' } : null,
            },
            h('div', { class: 'strong' }, r.title),
            r.detail ? h('div', { class: 'small muted' }, r.detail) : null),
          },
          { key: 'owner', label: 'Owner' },
          { key: 'priority', label: 'Priority', render: (r) => badge(r.priority) },
          {
            key: 'due_date', label: 'Due', align: 'right', render: (r) => h('div', {},
              h('div', { class: 'small' }, fmt.date(r.due_date)),
              r.overdue ? badge('Overdue', 'danger') : null),
          },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => modal(r) }, '✎'),
              h('button', { class: 'btn sm danger', onClick: () => remove(r) }, '×')),
          },
        ],
        rows: data.rows,
        empty: filters.status === 'Open' ? 'Nothing on the list' : 'No tasks match',
        emptyHint: 'Use this for reminders — chase a payment, confirm a trainer, follow up on a drive.',
      })));
  }

  async function toggle(t) {
    await api.put(`/api/tasks/${t.id}`, { ...t, status: t.status === 'Done' ? 'Open' : 'Done' });
    load();
  }

  function modal(t) {
    formModal({
      title: t ? 'Edit task' : 'New task',
      fields: [
        { name: 'title', label: 'Task', required: true, span: true },
        { name: 'detail', label: 'Detail', type: 'textarea', span: true, rows: 2 },
        { name: 'owner', label: 'Owner' },
        { name: 'priority', label: 'Priority', type: 'select', options: meta.enums.priority, required: true },
        { name: 'due_date', label: 'Due date', type: 'date', required: true },
        { name: 'status', label: 'Status', type: 'select', options: ['Open', 'Done'], required: true },
      ],
      values: t || { priority: 'Medium', status: 'Open', due_date: todayStr() },
      submitLabel: t ? 'Save' : 'Add task',
      async onSubmit(v, ctl) {
        if (t) await api.put(`/api/tasks/${t.id}`, v);
        else await api.post('/api/tasks', v);
        ctl.close();
        toast(t ? 'Task updated' : 'Task added', 'good');
        load();
      },
    });
  }

  async function remove(t) {
    const go = await confirmDialog({ title: 'Delete task', message: `Delete “${t.title}”?`, danger: true, confirmLabel: 'Delete' });
    if (!go) return;
    await api.del(`/api/tasks/${t.id}`);
    toast('Task deleted', 'good');
    load();
  }

  const form = buildForm([
    { name: 'status', label: 'Status', type: 'select', options: ['Open', 'Done'], placeholder: 'All' },
    { name: 'overdue', label: 'Only overdue', type: 'checkbox' },
  ], { ...filters, overdue: filters.overdue === '1' });

  form.el.className = 'filters';
  form.el.addEventListener('change', () => {
    const v = form.read();
    Object.assign(filters, { ...v, overdue: v.overdue ? '1' : '' });
    setQuery(filters);
    load();
  });

  host.appendChild(pageHead('Tasks', 'A shared to-do list for the front desk', [
    h('button', { class: 'btn primary', onClick: () => modal() }, '+ New task'),
  ]));
  host.appendChild(tileHost);
  host.appendChild(form.el);
  host.appendChild(tableHost);
  await load();
  return host;
}
