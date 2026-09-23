import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, debounce, clear, loading, statTile, todayStr,
} from '../ui.js';
import { setQuery } from '../router.js';
import { rankedBars } from '../charts.js';

export default async function expenses({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  const tileHost = h('div', { class: 'tiles' });
  const chartHost = h('div', { style: { marginTop: '14px' } });

  const monthStart = `${todayStr().slice(0, 7)}-01`;
  const filters = {
    q: query.q || '', category: query.category || '',
    from: query.from || monthStart, to: query.to || todayStr(),
  };

  const exportBtn = () => h('button', {
    class: 'btn sm', onClick: () => api.download('/api/expenses/export'),
  }, '↓ Export CSV');

  async function load() {
    clear(tableHost).appendChild(loading());
    const data = await api.get('/api/expenses', filters);
    const catRows = Object.entries(data.by_category)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
    // entries exist, just not inside the dates currently set
    const all = data.all_time || { count: 0 };
    const outside = !data.rows.length && all.count > 0;

    clear(tileHost).appendChild(h('div', { style: { display: 'contents' } },
      statTile({ label: 'Spent in range', value: fmt.money(data.total), tone: 'warn', sub: `${data.rows.length} entr${data.rows.length === 1 ? 'y' : 'ies'}` }),
      // Money on the big line, the category's name underneath — the tile sits
      // in a row of amounts, so reading across it should give amounts.
      statTile({
        label: 'Largest category',
        value: catRows.length ? fmt.money(catRows[0].value) : fmt.money(0),
        sub: catRows.length ? catRows[0].label : 'Nothing recorded yet',
      }),
      statTile({ label: 'Range', value: `${fmt.dateShort(filters.from)} → ${fmt.dateShort(filters.to)}` })));

    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, 'Expense entries'))),
      dataTable({
        columns: [
          { key: 'spent_on', label: 'Date', render: (r) => fmt.date(r.spent_on) },
          { key: 'category', label: 'Category', render: (r) => badge(r.category, 'navy') },
          { key: 'vendor', label: 'Vendor / payee' },
          { key: 'mode', label: 'Mode' },
          { key: 'reference', label: 'Reference', render: (r) => h('span', { class: 'small muted' }, r.reference || '—') },
          { key: 'remarks', label: 'Remarks', render: (r) => h('span', { class: 'small muted' }, r.remarks || '—') },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => h('span', { class: 'strong' }, fmt.money(r.amount)) },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => modal(r) }, '✎'),
              h('button', { class: 'btn sm danger', onClick: () => remove(r) }, '×')),
          },
        ],
        rows: data.rows,
        // export rides in the totals row rather than taking a row of its own
        footer: data.rows.length
          ? {
            spent_on: `${data.rows.length} entr${data.rows.length === 1 ? 'y' : 'ies'}`,
            amount: fmt.money(data.total),
            actions: exportBtn(),
          }
          : null,
        empty: outside
          ? `No expenses between ${fmt.dateShort(filters.from)} and ${fmt.dateShort(filters.to)}`
          : 'No expenses recorded yet',
        emptyHint: outside
          ? `${fmt.num(all.count)} entries are recorded outside this range, from `
            + `${fmt.dateShort(all.first)} to ${fmt.dateShort(all.last)}.`
          : 'Recording expenses turns the dashboard’s “net this month” into a real number.',
      }),
      /*
       * The screen opens on the current month. With nothing spent this month
       * the table was empty and said only "no expenses in this range", which
       * reads as "none have ever been recorded" — so the salaries and rent
       * already on file looked missing. Offer the way out rather than leaving
       * someone to work out that the date boxes above are hiding them.
       */
      !data.rows.length && outside
        ? h('div', { class: 'export-bar' },
          h('button', {
            class: 'btn primary sm',
            onClick: () => {
              filters.from = '';
              filters.to = '';
              // clear the date boxes too, or they would still show the range
              // that is no longer being applied
              form.controls.from.input.value = '';
              form.controls.to.input.value = '';
              setQuery(filters);
              load();
            },
          }, `Show all ${fmt.num(all.count)} entries`),
          exportBtn())
        : null,
      // nothing to total when the table is empty, so the button needs its own row
      data.rows.length || outside ? null : h('div', { class: 'export-bar' }, exportBtn())));

    clear(chartHost).appendChild(card('Spend by category', rankedBars({
      rows: catRows, valueFormat: fmt.money, colorIndex: 3, limit: 10,
    }), { sub: `${fmt.dateShort(filters.from)} → ${fmt.dateShort(filters.to)}` }));
  }

  function modal(e) {
    formModal({
      title: e ? 'Edit expense' : 'Record an expense',
      fields: [
        { name: 'spent_on', label: 'Date', type: 'date', required: true },
        { name: 'category', label: 'Category', type: 'select', options: meta.enums.expense_categories, required: true },
        { name: 'amount', label: 'Amount', type: 'money', required: true },
        { name: 'mode', label: 'Paid by', type: 'select', options: meta.enums.payment_modes },
        { name: 'vendor', label: 'Vendor / payee' },
        { name: 'reference', label: 'Invoice / reference' },
        { name: 'remarks', label: 'Remarks', type: 'textarea', span: true, rows: 2 },
      ],
      values: e || { spent_on: todayStr(), category: 'Misc', mode: 'Bank Transfer' },
      submitLabel: e ? 'Save' : 'Record expense',
      async onSubmit(v, ctl) {
        if (e) await api.put(`/api/expenses/${e.id}`, v);
        else await api.post('/api/expenses', v);
        ctl.close();
        /*
         * Show what was just saved. The screen opens filtered to the current
         * month, so recording something dated earlier saved it correctly and
         * then left it out of the list — it looked like the entry had been
         * thrown away. Widen the range to reach it rather than reporting
         * success over an unchanged table.
         */
        const on = v.spent_on;
        const moved = on && ((filters.from && on < filters.from) || (filters.to && on > filters.to));
        if (moved) {
          if (filters.from && on < filters.from) filters.from = on;
          if (filters.to && on > filters.to) filters.to = on;
          form.controls.from.input.value = filters.from;
          form.controls.to.input.value = filters.to;
          setQuery(filters);
        }
        toast(
          `${e ? 'Expense updated' : 'Expense recorded'}${moved ? ` · showing from ${fmt.dateShort(on)}` : ''}`,
          'good',
        );
        load();
      },
    });
  }

  async function remove(e) {
    const go = await confirmDialog({
      title: 'Delete expense',
      message: `Delete the ${fmt.money(e.amount)} ${e.category} entry from ${fmt.date(e.spent_on)}?`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!go) return;
    await api.del(`/api/expenses/${e.id}`);
    toast('Expense deleted', 'good');
    load();
  }

  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Vendor, reference, remarks' },
    { name: 'category', label: 'Category', type: 'select', options: meta.enums.expense_categories, placeholder: 'All categories' },
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
  ], filters);

  const apply = () => { Object.assign(filters, form.read()); setQuery(filters); load(); };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  host.appendChild(pageHead('Expenses', 'What the institute spends, so profit is a real figure', [
    h('button', { class: 'btn primary', onClick: () => modal() }, '+ Record expense'),
  ]));
  host.appendChild(tileHost);
  host.appendChild(form.el);
  host.appendChild(tableHost);
  host.appendChild(chartHost);
  await load();
  return host;
}
