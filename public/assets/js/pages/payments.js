import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, buildForm, debounce, clear, loading,
  statTile, formModal, toast, openModal, todayStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';
import { paymentModal } from './shared-forms.js';
import { rankedBars } from '../charts.js';

export default async function payments({ params, query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  const tileHost = h('div', { class: 'tiles' });
  const splitHost = h('div', { style: { marginTop: '14px' } });

  const monthStart = `${todayStr().slice(0, 7)}-01`;
  const filters = {
    q: query.q || '',
    mode: query.mode || '',
    from: query.from || monthStart,
    to: query.to || todayStr(),
    include_voided: query.include_voided || '',
  };

  const exportBtn = () => h('button', {
    class: 'btn sm', onClick: () => api.download('/api/payments/export', { from: filters.from, to: filters.to }),
  }, '↓ Export CSV');

  async function load() {
    clear(tableHost).appendChild(loading());
    const data = await api.get('/api/payments', filters);

    const modeRows = Object.entries(data.by_mode)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);

    clear(tileHost).appendChild(h('div', { style: { display: 'contents' } },
      statTile({ label: 'Collected in range', value: fmt.money(data.total), tone: 'accent', sub: `${data.count} receipt(s)` }),
      // Money on the big line, the mode's name underneath — the tile sits in a
      // row of amounts, so reading across it should give amounts.
      statTile({
        label: 'Top mode',
        value: modeRows.length ? fmt.money(modeRows[0].value) : fmt.money(0),
        sub: modeRows.length ? modeRows[0].label : 'No payments yet',
      }),
      statTile({
        label: 'Average receipt',
        value: data.count ? fmt.money(data.total / data.count) : fmt.money(0),
      }),
      statTile({ label: 'Range', value: `${fmt.dateShort(filters.from)} → ${fmt.dateShort(filters.to)}` })));

    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, 'Receipts'),
          h('div', { class: 'sub' }, 'Click a row to open the printable receipt')),
        h('div', { class: 'right' },
          h('button', { class: 'btn sm', onClick: () => dayBook() }, '▤ Day collection'))),
      dataTable({
        columns: [
          { key: 'receipt_no', label: 'Receipt no.', render: (r) => h('span', { class: 'mono strong' }, r.receipt_no) },
          { key: 'paid_on', label: 'Date', render: (r) => fmt.date(r.paid_on) },
          {
            key: 'student_name', label: 'Student', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.student_name),
              h('div', { class: 'small muted' }, `${r.reg_no} · ${r.course_name}`)),
          },
          { key: 'mode', label: 'Mode', render: (r) => badge(r.mode, 'navy') },
          { key: 'reference', label: 'Reference', render: (r) => h('span', { class: 'small muted' }, r.reference || '—') },
          { key: 'collected_by', label: 'Collected by', render: (r) => h('span', { class: 'small' }, r.collected_by || '—') },
          {
            key: 'amount', label: 'Amount', align: 'right', render: (r) => h('div', {},
              h('div', { class: r.voided ? 'muted' : 'strong' }, fmt.money(r.amount)),
              r.voided ? badge('Void', 'danger') : null),
          },
          {
            // the two buttons that act on the receipt, under a heading of their own
            key: 'receipt_actions', label: 'Receipt', align: 'center',
            render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => api.openTab(`/api/payments/${r.id}/receipt`) }, 'Print'),
              r.voided
                ? null
                : h('button', { class: 'btn sm', onClick: (e) => { e.stopPropagation(); emailReceipt(r); } }, '✉ Email')),
          },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => navigate(`/students/${r.student_id}`) }, 'Student')),
          },
        ],
        rows: data.rows,
        rowClass: (r) => (r.voided ? 'muted' : ''),
        onRow: (r) => api.openTab(`/api/payments/${r.id}/receipt`),
        // export rides in the totals row rather than taking a row of its own
        footer: data.rows.length
          ? { receipt_no: `${data.count} receipt(s)`, amount: fmt.money(data.total), actions: exportBtn() }
          : null,
        empty: 'No payments in this range',
        emptyHint: 'Widen the date range, or record a payment from a student profile.',
      }),
      // nothing to total when the table is empty, so the button needs its own row
      data.rows.length ? null : h('div', { class: 'export-bar' }, exportBtn())));

    // Mode split, rendered below the table.
    clear(splitHost).appendChild(card('Collection by mode', rankedBars({
      rows: modeRows, valueFormat: fmt.money, colorIndex: 2, limit: 8,
    }), { sub: `${fmt.dateShort(filters.from)} → ${fmt.dateShort(filters.to)}` }));
  }

  async function dayBook() {
    const date = todayStr();
    const data = await api.get('/api/payments/summary/day', { date });
    openModal({
      title: `Collection for ${fmt.date(date)}`,
      size: 'wide',
      body: h('div', {},
        h('div', { class: 'alert info', style: { marginBottom: '14px' } },
          h('div', {}, h('b', {}, fmt.money(data.total)), ` collected across ${data.rows.length} receipt(s).`,
            Object.entries(data.by_mode).length
              ? h('div', { class: 'small', style: { marginTop: '4px' } },
                Object.entries(data.by_mode).map(([m, v]) => `${m}: ${fmt.money(v)}`).join('  ·  '))
              : null)),
        dataTable({
          columns: [
            { key: 'receipt_no', label: 'Receipt', render: (r) => h('span', { class: 'mono' }, r.receipt_no) },
            { key: 'student_name', label: 'Student' },
            { key: 'course_name', label: 'Course' },
            { key: 'mode', label: 'Mode' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmt.money(r.amount) },
          ],
          rows: data.rows,
          footer: { receipt_no: 'Total', amount: fmt.money(data.total) },
          empty: 'Nothing collected today yet',
        })),
      footer: [h('button', { class: 'btn', onClick: () => window.print() }, 'Print')],
    });
  }

  /**
   * Email the bill to the student. The address on their record is offered as
   * the default but stays editable, so a one-off can go to a parent or a work
   * address without changing the student's own details.
   */
  function emailReceipt(r) {
    formModal({
      title: `Email receipt ${r.receipt_no}`,
      size: 'narrow',
      fields: [
        {
          type: 'node',
          span: true,
          node: h('div', { class: 'alert info' },
            h('span', { class: 'ico' }, '✉'),
            h('div', {}, `The bill for ${fmt.money(r.amount)} goes to `,
              h('b', {}, r.student_name), ' as an attachment.')),
        },
        {
          name: 'to', label: 'Send to', type: 'email', required: true, span: true,
          hint: r.student_email
            ? 'Taken from the student\'s record — change it for a one-off.'
            : 'This student has no email saved. Add one on their profile to have it filled in next time.',
        },
      ],
      values: { to: r.student_email || '' },
      submitLabel: 'Send receipt',
      async onSubmit(v, ctl) {
        await api.post(`/api/payments/${r.id}/email`, v);
        ctl.close();
        toast(`Receipt ${r.receipt_no} emailed to ${v.to}`, 'good');
      },
    });
  }

  /** Pick a student first, then open the standard payment modal. */
  async function record() {
    const { rows } = await api.get('/api/students', { limit: 500, sort: 'name', dues: '1' });
    const all = rows.length ? rows : (await api.get('/api/students', { limit: 500, sort: 'name' })).rows;
    if (!all.length) { toast('Add a student first.', 'warn'); return; }

    formModal({
      title: 'Record a payment',
      size: 'narrow',
      fields: [{
        name: 'student_id', label: 'Student', type: 'select', required: true, span: true,
        placeholder: 'Search by name or registration number',
        options: all.map((s) => ({
          value: s.id,
          label: `${s.name} — ${s.reg_no}${s.balance > 0 ? ` (${fmt.money(s.balance)} due)` : ''}`,
        })),
      }],
      submitLabel: 'Continue',
      async onSubmit(v, ctl) {
        ctl.close();
        const s = await api.get(`/api/students/${v.student_id}`);
        paymentModal({ meta, student: s, enrollments: s.enrollments, onSaved: load });
      },
    });
  }

  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Receipt no, student, reference' },
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
    { name: 'mode', label: 'Mode', type: 'select', options: meta.enums.payment_modes, placeholder: 'All modes' },
    { name: 'include_voided', label: 'Include voided receipts', type: 'checkbox' },
  ], { ...filters, include_voided: filters.include_voided === '1' });

  const apply = () => {
    const v = form.read();
    Object.assign(filters, { ...v, include_voided: v.include_voided ? '1' : '' });
    setQuery(filters);
    load();
  };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Payments', 'Every receipt, searchable and printable', [
    h('button', { class: 'btn', onClick: dayBook }, '▤ Today’s collection'),
    h('button', { class: 'btn primary', onClick: record }, '+ Record payment'),
  ]));
  host.appendChild(tileHost);
  host.appendChild(form.el);
  host.appendChild(tableHost);
  host.appendChild(splitHost);

  await load();
  if (params.id) api.openTab(`/api/payments/${params.id}/receipt`);
  return host;
}
