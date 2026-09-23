import { api } from '../api.js';
import { h, fmt, pageHead, badge, toast, clear, loading, batchBadge } from '../ui.js';
import { navigate } from '../router.js';

/** Kanban board over the student lifecycle. Drag a card to change its stage. */
export default async function pipeline() {
  const host = h('div', {});
  const boardHost = h('div', {});

  async function load() {
    clear(boardHost).appendChild(loading());
    const { columns } = await api.get('/api/students/pipeline');
    const total = columns.reduce((n, c) => n + c.cards.length, 0);

    const board = h('div', { class: 'kanban' }, columns.map((col) => {
      const body = h('div', { class: 'kcol-body' }, col.cards.map((s) => cardEl(s)));
      const column = h('div', { class: 'kcol', dataset: { stage: col.stage } },
        h('div', { class: 'kcol-head' },
          h('span', {}, col.stage),
          h('span', { class: 'n' }, col.cards.length)),
        body);

      column.addEventListener('dragover', (e) => {
        e.preventDefault();
        column.classList.add('dragover');
      });
      column.addEventListener('dragleave', () => column.classList.remove('dragover'));
      column.addEventListener('drop', async (e) => {
        e.preventDefault();
        column.classList.remove('dragover');
        const id = e.dataTransfer.getData('text/plain');
        const from = e.dataTransfer.getData('application/x-stage');
        if (!id || from === col.stage) return;
        try {
          await api.post(`/api/students/${id}/stage`, { stage: col.stage, note: 'Moved on the pipeline board' });
          toast(`Moved to ${col.stage}`, 'good');
          load();
        } catch (err) {
          toast(err.message, 'danger');
          load();
        }
      });
      return column;
    }));

    clear(boardHost).appendChild(h('div', {},
      h('div', { class: 'small muted', style: { marginBottom: '10px' } },
        `${total} student(s) on the board. Drag a card between columns to change its stage — every move is logged.`),
      board));
  }

  function cardEl(s) {
    const el = h('div', {
      class: 'kcard', draggable: 'true',
      onClick: () => navigate(`/students/${s.id}`),
    },
    h('div', { class: 'n' }, s.name),
    h('div', { class: 'm' }, `${s.reg_no}${s.course_name ? ` · ${s.course_name}` : ''}`),
    h('div', { class: 'f' },
      s.batch_code ? batchBadge(s.batch_start, s.batch_code) : null,
      s.balance > 0
        ? h('span', { class: 'money-neg', style: { marginLeft: 'auto' } }, fmt.moneyShort(s.balance))
        : h('span', { class: 'money-pos', style: { marginLeft: 'auto' } }, 'Paid')));

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(s.id));
      e.dataTransfer.setData('application/x-stage', s.stage);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    return el;
  }

  host.appendChild(pageHead(
    'Student pipeline',
    'The end-to-end journey from admission to placement',
    [h('button', { class: 'btn', onClick: load }, '↻ Refresh'),
      h('button', { class: 'btn navy', onClick: () => navigate('/students') }, 'Table view')],
  ));
  host.appendChild(boardHost);

  await load();
  return host;
}
