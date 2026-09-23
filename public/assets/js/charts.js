/**
 * Dependency-free SVG charts.
 *
 * Design rules applied throughout:
 *  - one value axis only (never a second y-scale)
 *  - categorical series take fixed palette slots in order, never cycled
 *  - thin marks with 4px rounded data-ends anchored to the baseline
 *  - a 2px surface gap between adjacent bars
 *  - recessive grid/axes; a legend whenever there are 2+ series
 *  - hover tooltip on every mark
 */

import { h, fmt } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

const s = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, v);
  }
  return el;
};

const text = (str, attrs) => { const t = s('text', attrs); t.textContent = str; return t; };

/* Axis labels are 11px (see .chart .tick), which averages out near enough. */
const CHAR_W = 6.1;
const LINE_H = 13;

/**
 * Break one x-axis label so it fits the width of its bar, keeping it upright.
 * Splits after a space or a hyphen — "Fee collections" and "DA-101-2026C" both
 * have a natural seam — and only cuts mid-word as a last resort. Three lines is
 * the limit; past that the axis is taller than the chart it explains, and the
 * hover tooltip carries the full name anyway.
 */
function wrapLabel(value, perLine, maxLines = 3) {
  const str = String(value ?? '');
  if (str.length <= perLine) return [str];

  const lines = [];
  let cur = '';
  for (const part of str.split(/(?<=[-\s])/)) {
    if (cur && (cur + part).trim().length > perLine) { lines.push(cur.trim()); cur = part; }
    else cur += part;
  }
  if (cur.trim()) lines.push(cur.trim());

  // a single word wider than the slot, or more lines than we allow
  const out = lines.slice(0, maxLines).map((l) => (l.length > perLine ? `${l.slice(0, Math.max(1, perLine - 1))}…` : l));
  if (lines.length > maxLines) {
    const last = out[maxLines - 1];
    out[maxLines - 1] = last.endsWith('…') ? last : `${last.slice(0, Math.max(1, perLine - 1))}…`;
  }
  return out;
}

/** One upright axis label, one tspan per line. */
function xLabel(lines, x, y) {
  const t = s('text', { class: 'tick', x, y, 'text-anchor': 'middle' });
  lines.forEach((line, i) => {
    const span = s('tspan', { x, dy: i === 0 ? 0 : LINE_H });
    span.textContent = line;
    t.appendChild(span);
  });
  return t;
}

/** Round a maximum up to a friendly tick value. */
function niceMax(max) {
  if (!Number.isFinite(max) || max <= 0) return 10;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

// ------------------------------------------------------------ tooltip
let tipEl = null;
function showTip(evt, node) {
  if (!tipEl) {
    tipEl = h('div', { class: 'chart-tip' });
    document.body.appendChild(tipEl);
  }
  tipEl.replaceChildren(node);
  tipEl.style.display = '';
  moveTip(evt);
}
function moveTip(evt) {
  if (!tipEl) return;
  const pad = 14;
  const r = tipEl.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY - r.height - 8;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y < 8) y = evt.clientY + pad;
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

function tipContent(title, rows) {
  return h('div', {},
    h('div', { class: 't' }, title),
    rows.map((r) => h('div', { class: 'r' },
      r.color ? h('span', { class: 'sw', style: { background: r.color } }) : null,
      h('span', {}, r.label),
      h('span', { class: 'v' }, r.value))));
}

// ------------------------------------------------------------- legend
function legend(series) {
  if (series.length < 2) return null;
  return h('div', { class: 'legend' }, series.map((sr, i) => h('div', { class: 'item' },
    h('span', { class: 'swatch', style: { background: SERIES[i % SERIES.length] } }),
    sr.label)));
}

const noData = (msg = 'No data for this period yet') => h('div', { class: 'no-data' }, msg);

/** Re-render on container resize so the SVG always matches its box. */
function responsive(host, draw) {
  const run = () => {
    const w = host.clientWidth;
    if (!w) return;
    host.replaceChildren(draw(w));
  };
  run();
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => run());
    ro.observe(host);
  }
  return host;
}

// ------------------------------------------------------- grouped bars
/**
 * rows:   [{ [xKey]: 'Feb 26', collected: 1200, expenses: 900 }, ...]
 * series: [{ key, label }]
 */
export function barChart({
  rows, xKey, series, height = 220, valueFormat = fmt.moneyShort, xFormat = (v) => v,
  max: forcedMax,
}) {
  const host = h('div', { class: 'chart' });
  if (!rows || !rows.length) { host.appendChild(noData()); return host; }

  const wrap = h('div', {}, legend(series), host);

  responsive(host, (width) => {
    const padL = 52; const padR = 10; const padT = 12;
    const plotW = Math.max(60, width - padL - padR);

    /*
     * Every bar is named, and every name reads horizontally. The axis used to
     * drop every second label once they crowded, which reads as broken: batch
     * codes differ only in the final character, so an unlabelled bar next to
     * BI-105-2026A looks like the same batch charted twice. A name too wide
     * for its slot wraps onto a second line instead — the chart grows
     * downwards rather than the label turning on its side.
     */
    const slot = plotW / rows.length;
    const perLine = Math.max(4, Math.floor((slot - 4) / CHAR_W));
    const labelLines = rows.map((r) => wrapLabel(xFormat(r[xKey]), perLine));
    const lineCount = Math.max(...labelLines.map((l) => l.length));
    const padB = 17 + lineCount * LINE_H;
    // the plot keeps its height; the chart grows downwards to find the room
    const totalH = height - 30 + padB;
    const plotH = totalH - padT - padB;

    // a percentage axis is fixed at 100, so bars stay comparable across reports
    const max = forcedMax
      || niceMax(Math.max(...rows.flatMap((r) => series.map((sr) => Number(r[sr.key]) || 0))));
    const yOf = (v) => padT + plotH - (Math.max(0, v) / max) * plotH;

    const svg = s('svg', {
      width, height: totalH, viewBox: `0 0 ${width} ${totalH}`, role: 'img',
    });

    // grid + value ticks
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const y = yOf(v);
      svg.appendChild(s('line', { class: 'grid-line', x1: padL, x2: width - padR, y1: y, y2: y }));
      svg.appendChild(text(valueFormat(v), {
        class: 'tick', x: padL - 8, y: y + 3.5, 'text-anchor': 'end',
      }));
    }
    svg.appendChild(s('line', {
      class: 'axis-line', x1: padL, x2: width - padR, y1: yOf(0), y2: yOf(0),
    }));

    const groupW = Math.min(slot * 0.72, 54);
    const gap = 2;                                   // surface gap between bars
    const barW = Math.max(3, (groupW - gap * (series.length - 1)) / series.length);

    rows.forEach((row, ri) => {
      const gx = padL + slot * ri + (slot - groupW) / 2;

      series.forEach((sr, si) => {
        const v = Number(row[sr.key]) || 0;
        const x = gx + si * (barW + gap);
        const y = yOf(v);
        const bh = Math.max(v > 0 ? 2 : 0, yOf(0) - y);
        const rect = s('rect', {
          class: 'bar', x, y, width: barW, height: bh,
          rx: Math.min(4, barW / 2), fill: SERIES[si % SERIES.length],
        });
        rect.addEventListener('mouseenter', (e) => showTip(e, tipContent(
          xFormat(row[xKey]),
          series.map((s2, i2) => ({
            color: SERIES[i2 % SERIES.length],
            label: s2.label,
            // nothing recorded is not the same as zero, and must not read as it
            value: row[s2.key] == null ? '—' : valueFormat(Number(row[s2.key]) || 0),
          })),
        )));
        rect.addEventListener('mousemove', moveTip);
        rect.addEventListener('mouseleave', hideTip);
        svg.appendChild(rect);
      });

      // Every bar gets its name, upright, on as many lines as it takes.
      svg.appendChild(xLabel(labelLines[ri], gx + groupW / 2, totalH - padB + 15));
    });

    return svg;
  });

  return wrap;
}

// ------------------------------------------------------------- line
export function lineChart({
  rows, xKey, series, height = 220, valueFormat = fmt.moneyShort, xFormat = (v) => v,
}) {
  const host = h('div', { class: 'chart' });
  if (!rows || rows.length < 2) { host.appendChild(noData('Not enough history to plot a trend yet')); return host; }

  const wrap = h('div', {}, legend(series), host);

  responsive(host, (width) => {
    const padL = 52; const padR = 14; const padT = 12; const padB = 30;
    const plotW = Math.max(60, width - padL - padR);
    const plotH = height - padT - padB;

    const max = niceMax(Math.max(...rows.flatMap((r) => series.map((sr) => Number(r[sr.key]) || 0))));
    const xOf = (i) => padL + (plotW / (rows.length - 1)) * i;
    const yOf = (v) => padT + plotH - (Math.max(0, v) / max) * plotH;

    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const y = yOf(v);
      svg.appendChild(s('line', { class: 'grid-line', x1: padL, x2: width - padR, y1: y, y2: y }));
      svg.appendChild(text(valueFormat(v), { class: 'tick', x: padL - 8, y: y + 3.5, 'text-anchor': 'end' }));
    }

    series.forEach((sr, si) => {
      const colour = SERIES[si % SERIES.length];
      const pts = rows.map((r, i) => `${xOf(i)},${yOf(Number(r[sr.key]) || 0)}`).join(' ');
      svg.appendChild(s('polyline', {
        points: pts, fill: 'none', stroke: colour, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
      rows.forEach((r, i) => {
        const dot = s('circle', {
          cx: xOf(i), cy: yOf(Number(r[sr.key]) || 0), r: 4,
          fill: colour, stroke: 'var(--surface)', 'stroke-width': 2,
        });
        dot.addEventListener('mouseenter', (e) => showTip(e, tipContent(
          xFormat(r[xKey]),
          series.map((s2, i2) => ({
            color: SERIES[i2 % SERIES.length],
            label: s2.label,
            value: valueFormat(Number(r[s2.key]) || 0),
          })),
        )));
        dot.addEventListener('mousemove', moveTip);
        dot.addEventListener('mouseleave', hideTip);
        svg.appendChild(dot);
      });
    });

    const every = Math.ceil(rows.length / Math.max(3, Math.floor(plotW / 62)));
    rows.forEach((r, i) => {
      if (i % every) return;
      svg.appendChild(text(xFormat(r[xKey]), {
        class: 'tick', x: xOf(i), y: height - 10, 'text-anchor': 'middle',
      }));
    });

    return svg;
  });

  return wrap;
}

// -------------------------------------------------- horizontal bars
/**
 * A ranked distribution — one series, direct-labelled, so no legend is needed.
 * rows: [{ label, value, sub }]
 */
export function rankedBars({ rows, valueFormat = fmt.num, max: forcedMax, colorIndex = 0, limit = 10 }) {
  const data = (rows || []).filter((r) => r && r.label != null).slice(0, limit);
  if (!data.length) return h('div', { class: 'chart' }, noData());

  const max = forcedMax || Math.max(...data.map((r) => Number(r.value) || 0)) || 1;
  const colour = SERIES[colorIndex % SERIES.length];

  return h('div', { class: 'chart' }, h('div', { style: { display: 'grid', gap: '9px' } },
    data.map((r) => {
      const v = Number(r.value) || 0;
      const pct = Math.max(v > 0 ? 2 : 0, (v / max) * 100);
      // clamped: a fill bigger than the value it sits inside would overflow the bar
      const fill = Math.min(Number(r.fill) || 0, v);
      const hasFill = r.fill != null;
      const fillPct = (fill / max) * 100;
      return h('div', {},
        h('div', {
          style: {
            display: 'flex', gap: '10px', fontSize: '12.5px', marginBottom: '4px', alignItems: 'baseline',
          },
        },
        h('span', { style: { color: 'var(--ink-2)', fontWeight: '550' } }, r.label),
        r.sub ? h('span', { class: 'muted small' }, r.sub) : null,
        h('span', {
          class: 'mono',
          style: { marginLeft: 'auto', fontWeight: '650', color: 'var(--ink)' },
        }, valueFormat(v))),
        /*
         * A row can carry `fill` — a part of its own value worth marking out,
         * such as how many of a company's applicants actually joined. The bar's
         * length still measures `value`, so the ranking is unchanged; the solid
         * segment inside it measures `fill`.
         *
         * Both widths are taken against the same `max`, so the solid parts are
         * comparable across rows and not just within one. Two applications with
         * one joined therefore reads as a half-marked bar rather than a full
         * one, which is what a full bar was being mistaken for.
         */
        h('div', {
          style: {
            height: '8px', background: 'var(--surface-3)',
            borderRadius: '4px', position: 'relative', overflow: 'hidden',
          },
        },
        h('div', {
          style: {
            position: 'absolute', left: '0', top: '0', bottom: '0',
            width: `${pct}%`, background: colour,
            opacity: hasFill ? '.3' : '1',
            borderRadius: '4px', transition: 'width .3s',
          },
        }),
        hasFill
          ? h('div', {
            style: {
              position: 'absolute', left: '0', top: '0', bottom: '0',
              width: `${fillPct}%`, background: colour,
              borderRadius: '4px', transition: 'width .3s',
            },
          })
          : null));
    })));
}

const REPORT_FORMATS = {
  money: fmt.moneyShort,
  percent: (v) => `${Math.round(Number(v) || 0)}%`,
  number: fmt.num,
};

/** Render whatever `chart` spec a report returns. */
export function reportChart(spec, rows) {
  if (!spec || !rows || !rows.length) return null;
  const isMoney = spec.series.some((sr) => /amount|collect|expense|revenue|balance|billed|unpaid/i.test(sr.key));
  const format = REPORT_FORMATS[spec.format] || (isMoney ? fmt.moneyShort : fmt.num);
  // No blunt truncation here — the axis wraps a long name onto another line,
  // and cutting it first would only produce "Machine Learning E".
  const xFormat = /period|month/i.test(spec.x) ? fmt.month : (v) => String(v ?? '');
  return barChart({
    rows, xKey: spec.x, series: spec.series, valueFormat: format, xFormat, height: 250,
    max: spec.max,
  });
}
