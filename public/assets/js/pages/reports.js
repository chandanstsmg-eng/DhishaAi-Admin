import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, buildForm, clear, loading, statTile, dateStr, todayStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';
import { reportChart } from '../charts.js';

export default async function reports({ params, query }) {
  const host = h('div', {});
  const bodyHost = h('div', { class: 'report-body' });
  const { reports: catalogue } = await api.get('/api/reports');

  const current = params.key || query.key || catalogue[0].key;
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const range = { from: query.from || yearStart, to: query.to || todayStr() };

  const meta = catalogue.find((r) => r.key === current) || catalogue[0];

  // ------------------------------------------------------- picker
  const grouped = {};
  for (const r of catalogue) (grouped[r.group] = grouped[r.group] || []).push(r);

  const picker = card('Reports', h('div', { style: { display: 'grid', gap: '14px' } },
    Object.entries(grouped).map(([group, rows]) => h('div', {},
      h('div', {
        style: {
          fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '1.2px',
          color: 'var(--ink-3)', fontWeight: '700', marginBottom: '6px',
        },
      }, group),
      h('div', { style: { display: 'grid', gap: '3px' } }, rows.map((r) => h('a', {
        href: `#/reports/${r.key}?from=${range.from}&to=${range.to}`,
        dataset: r.key === current ? { active: '1' } : {},
        style: {
          display: 'block', padding: '7px 10px', borderRadius: '7px',
          color: r.key === current ? '#fff' : 'var(--ink)',
          background: r.key === current ? 'var(--navy)' : 'transparent',
          fontWeight: r.key === current ? '600' : '400', textDecoration: 'none', fontSize: '13.5px',
        },
      }, r.name)))))));
  picker.classList.add('report-picker');

  /**
   * Give the two columns the rest of the viewport, so each scrolls inside
   * itself and the page has nothing left to scroll — the catalogue then holds
   * still while the report is read.
   *
   * The height has to be measured: how much room is left depends on the header
   * and the date bar above, which CSS has no way to know. Below 980px the
   * columns are stacked and the page scrolls normally, so the height comes off
   * again — a scroll box inside a scrolling page is worse than either.
   */
  function fitLayout() {
    if (window.matchMedia('(max-width: 980px)').matches) {
      layout.classList.remove('split');
      layout.style.height = '';
      return;
    }
    layout.classList.add('split');
    // measured from the document, not the viewport, so a page that happens to
    // be scrolled when this runs cannot bake its offset into the height
    const top = layout.getBoundingClientRect().top + document.scrollingElement.scrollTop;
    // the gap below is the content column's own padding — guessing at it left
    // the page a few pixels scrollable, which is enough to nudge the whole
    // layout and undo the point of this
    const content = layout.closest('.content');
    const gap = content ? parseFloat(getComputedStyle(content).paddingBottom) || 0 : 0;
    layout.style.height = `${Math.max(320, window.innerHeight - top - gap)}px`;
  }

  /**
   * Bring the open report into view inside its own list. scrollIntoView would
   * scroll every scrollable ancestor including the window, dragging the report
   * itself off the top of the screen; this moves the list and nothing else.
   */
  function revealActive() {
    const link = picker.querySelector('a[data-active]');
    if (!link) return;
    const box = picker.getBoundingClientRect();
    const row = link.getBoundingClientRect();
    const head = picker.querySelector('.card-head');
    const top = box.top + (head ? head.getBoundingClientRect().height : 0);
    if (row.top < top) picker.scrollTop -= (top - row.top) + 8;
    else if (row.bottom > box.bottom) picker.scrollTop += (row.bottom - box.bottom) + 8;
  }

  // -------------------------------------------------------- range
  const form = buildForm([
    { name: 'from', label: 'From', type: 'date', disabled: !meta.dated },
    { name: 'to', label: 'To', type: 'date', disabled: !meta.dated },
  ], range);
  form.el.className = 'filters';
  form.el.addEventListener('change', () => {
    Object.assign(range, form.read());
    setQuery(range);
    load();
  });

  const preset = (label, from, to) => h('button', {
    class: 'btn sm',
    onClick: () => {
      Object.assign(range, { from, to });
      form.controls.from.input.value = from;
      form.controls.to.input.value = to;
      setQuery(range);
      load();
    },
  }, label);

  const today = new Date();
  // local calendar dates, not UTC — see dateStr in ui.js
  const iso = (d) => dateStr(d);
  const monthsAgo = (n) => iso(new Date(today.getFullYear(), today.getMonth() - n, today.getDate()));

  if (meta.dated) {
    form.el.appendChild(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-end', flexWrap: 'wrap' } },
      preset('This month', `${iso(today).slice(0, 7)}-01`, iso(today)),
      preset('Last 3 months', monthsAgo(3), iso(today)),
      preset('Last 12 months', monthsAgo(12), iso(today)),
      preset('This year', `${today.getFullYear()}-01-01`, iso(today))));
  }

  // --------------------------------------------------------- load
  async function load() {
    clear(bodyHost).appendChild(loading());
    let r;
    try {
      r = await api.get(`/api/reports/${current}`, meta.dated ? range : {});
    } catch (err) {
      clear(bodyHost).appendChild(card(null, h('div', { class: 'dt-empty' }, err.message)));
      return;
    }

    /*
     * Which totals are money, and which read as a problem, is inferred from the
     * key's wording — so a report that renames a column into plainer English
     * has to add that word here, or the figure silently loses its ₹.
     */
    const totalTiles = Object.entries(r.totals || {}).map(([k, v]) => statTile({
      label: k.replace(/_/g, ' '),
      value: typeof v === 'number' && /amount|collect|expense|revenue|balance|billed|net|income|unpaid/i.test(k)
        ? fmt.money(v) : fmt.num(v),
      tone: /net|income|collect/i.test(k) ? 'good' : /expense|balance|outstanding|unpaid/i.test(k) ? 'warn' : '',
    }));

    const render = (row, c) => {
      const v = row[c.key];
      if (v == null || v === '') return h('span', { class: 'muted' }, '—');
      if (c.type === 'money') {
        return h('span', { class: `mono ${/outstanding|balance|unpaid/i.test(c.key) && v > 0 ? 'money-neg' : ''}` }, fmt.money(v));
      }
      if (c.type === 'number') return h('span', { class: 'mono' }, fmt.num(v));
      if (c.type === 'date') return fmt.date(v);
      if (c.key === 'status') return badge(v);
      if (c.key === 'period') return fmt.month(v);
      return String(v);
    };

    /*
     * A report may carry one chart or several. Several is how two measures of
     * different units are shown — one axis each, side by side — rather than
     * forcing them onto a shared scale.
     */
    const specs = r.charts || (r.chart ? [r.chart] : []);
    const period = meta.dated ? `${fmt.date(r.from)} → ${fmt.date(r.to)}` : 'All time';
    const charts = specs.map((spec, i) => h('div', { style: i ? { marginTop: '14px' } : null },
      card(spec.title || r.title, reportChart(spec, r.rows), { sub: period })));

    clear(bodyHost).appendChild(h('div', {},
      totalTiles.length ? h('div', { class: 'tiles' }, totalTiles) : null,
      ...charts,
      h('div', { style: { marginTop: charts.length ? '14px' : '0' } },
        // The period is printed on the chart card. A report with no chart —
        // the day book, the ledger — would otherwise never say on screen which
        // dates produced it, which is the first thing anyone asks of a figure
        // they are about to hand on.
        card(charts.length ? 'Detail' : r.title, [dataTable({
          columns: r.columns.map((c) => ({
            key: c.key,
            label: c.label,
            align: ['money', 'number'].includes(c.type) ? 'right' : undefined,
            render: (row) => render(row, c),
          })),
          rows: r.rows,
          footer: Object.keys(r.totals || {}).length
            ? Object.fromEntries(r.columns.map((c) => [
              c.key,
              r.totals[c.key] != null
                ? (c.type === 'money' ? fmt.money(r.totals[c.key]) : fmt.num(r.totals[c.key]))
                : (c === r.columns[0] ? 'Total' : ''),
            ]))
            : null,
          empty: 'No data for this selection',
          emptyHint: meta.dated ? 'Try a wider date range.' : 'Records will appear here as you use the portal.',
        }),
        h('div', { class: 'export-bar' },
          h('button', {
            class: 'btn sm',
            onClick: () => api.download(`/api/reports/${current}/export`, meta.dated ? range : {}),
          }, '↓ Export CSV')),
        ], { flush: true, sub: charts.length ? null : period }))));
  }

  host.appendChild(pageHead('Reports', 'Numbers you can hand to an accountant or a board', [
    h('button', { class: 'btn', onClick: () => window.print() }, '⎙ Print'),
    h('button', {
      class: 'btn navy',
      onClick: () => api.download(`/api/reports/${current}/export`, meta.dated ? range : {}),
    }, '↓ Export current report'),
  ]));
  host.appendChild(form.el);
  const layout = h('div', { class: 'report-layout' }, picker, bodyHost);
  host.appendChild(layout);

  /*
   * Re-measure when the window changes shape, including crossing the 980px
   * breakpoint in either direction. The router has no teardown hook, so the
   * listener retires itself once the screen it measures is gone.
   */
  const onResize = () => {
    if (!layout.isConnected) { window.removeEventListener('resize', onResize); return; }
    fitLayout();
  };
  window.addEventListener('resize', onResize);

  await load();
  // the router appends this element after we return, so the measuring has to
  // wait for it to be on the page and laid out
  setTimeout(() => { fitLayout(); revealActive(); }, 0);
  return host;
}
