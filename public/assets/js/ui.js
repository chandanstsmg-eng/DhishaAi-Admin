/** Shared UI kit: DOM helper, formatters, tables, forms, modals, toasts. */

import { ApiError } from './api.js';

// ------------------------------------------------------------ DOM
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs.nodeType || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'selected', 'readOnly'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
}

export const frag = (...kids) => { const f = document.createDocumentFragment(); append(f, kids); return f; };
/**
 * Empty an element, holding its height until real content replaces it.
 *
 * Screens swap their table out for a spinner while data loads. Without this the
 * container collapses to spinner-height and springs back a moment later, and
 * that rebound is what makes the page look like it is jumping about on every
 * filter change or click. The height is released the instant something other
 * than the placeholder is put back, so nothing is left padded out.
 */
export const clear = (el) => {
  const held = el.offsetHeight;
  if (held > 0) {
    el.style.minHeight = `${held}px`;
    if (!el.__holdObserver) {
      el.__holdObserver = new MutationObserver(() => {
        const first = el.firstElementChild;
        const placeholderOnly = el.children.length === 1 && first && first.dataset.loading === '1';
        if (el.children.length && !placeholderOnly) el.style.minHeight = '';
      });
      el.__holdObserver.observe(el, { childList: true });
    }
  }
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ----------------------------------------------------- formatters
let CURRENCY = '₹';
export const setCurrency = (c) => { CURRENCY = c || '₹'; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmt = {
  money(n, { decimals = 0, sign = false } = {}) {
    const v = Number(n) || 0;
    const s = Math.abs(v).toLocaleString('en-IN', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
    return `${v < 0 ? '−' : sign ? '+' : ''}${CURRENCY}${s}`;
  },
  /** Compact form for tiles and axis ticks: ₹1.2L, ₹3.4Cr. */
  moneyShort(n) {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    const sign = v < 0 ? '−' : '';
    if (a >= 1e7) return `${sign}${CURRENCY}${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
    if (a >= 1e5) return `${sign}${CURRENCY}${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
    if (a >= 1e3) return `${sign}${CURRENCY}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
    return `${sign}${CURRENCY}${Math.round(a)}`;
  },
  num: (n) => (Number(n) || 0).toLocaleString('en-IN'),
  pct: (n) => (n == null ? '—' : `${Math.round(n)}%`),
  /**
   * A batch is named by the day it starts: 02Jul2026. Read straight off the
   * ISO string rather than through Date, so the day never shifts by a timezone.
   */
  batch(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    return m ? `${m[3]}${MONTHS[Number(m[2]) - 1]}${m[1]}` : null;
  },
  date(d) {
    if (!d) return '—';
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return String(d);
    return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  dateShort(d) {
    if (!d) return '—';
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? String(d)
      : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  },
  month(m) {
    if (!m) return '—';
    const [y, mo] = String(m).split('-');
    const d = new Date(Number(y), Number(mo) - 1, 1);
    return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  },
  dateTime(d) {
    if (!d) return '—';
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? String(d)
      : x.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  },
  time(d) {
    const x = d ? new Date(d) : new Date();
    return Number.isNaN(x.getTime()) ? String(d)
      : x.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  },
  ago(d) {
    if (!d) return '—';
    const secs = (Date.now() - new Date(d).getTime()) / 1000;
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
    return fmt.date(d);
  },
  initials: (name) => String(name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase(),
};

/**
 * A Date as YYYY-MM-DD, read off the calendar the user is looking at.
 *
 * Never `toISOString().slice(0, 10)` for this. That converts to UTC first, and
 * India runs 5½ hours ahead — so a Date built from local midnight comes back as
 * the day before, every single time, and `new Date()` does the same between
 * midnight and 05:30. Dates typed into this app are calendar dates, not
 * instants: a due date of the 6th must read as the 6th.
 */
export const dateStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const todayStr = () => dateStr();

/** The calendar date `days` after an ISO date, staying on the local calendar. */
export const addDaysStr = (iso, days) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + (Number(days) || 0));
  return dateStr(d);
};

// --------------------------------------------------------- badges
const TONES = {
  Active: 'good', Ongoing: 'good', Present: 'good', Paid: 'good', Completed: 'info',
  Joined: 'good', Converted: 'good', Offered: 'good', Placed: 'good', Done: 'good',
  'On Hold': 'warn', Partial: 'warn', Pending: 'warn', Planned: 'info', Late: 'warn',
  Negotiating: 'warn', Interested: 'info', Contacted: 'info', New: 'accent', Open: 'warn',
  Dropped: 'danger', Cancelled: 'danger', Absent: 'danger', Lost: 'danger', Rejected: 'danger',
  Waived: 'info', Excused: 'info', High: 'danger', Medium: 'warn', Low: 'info',
  // a cancelled session is nobody's fault, so it gets the neutral tone
  'No class': '',
  Applied: 'info', Interview: 'accent',
};
export const toneFor = (value) => TONES[value] || 'navy';

export function badge(text, tone) {
  if (text == null || text === '') return h('span', { class: 'muted' }, '—');
  return h('span', { class: `badge ${tone || toneFor(text)}` }, String(text));
}

/**
 * A batch is named by its code — that is the number the office works from.
 * The start date rides along as the tooltip, and stands in only when a batch
 * somehow has no code.
 */
export function batchBadge(startDate, code, { tone = 'navy', empty = 'Unassigned' } = {}) {
  const started = fmt.batch(startDate);
  if (!code && !started) return badge(empty, 'warn');
  const el = badge(code || started, tone);
  if (code && started) el.title = `Starts ${started}`;
  return el;
}

/** The same name in plain text, for sub-lines and dropdown labels. */
export const batchText = (startDate, code) => code || fmt.batch(startDate) || '';

export function progressBar(percent, tone) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const cls = tone || (p >= 75 ? 'good' : p >= 40 ? 'warn' : '');
  return h('div', { class: `progress ${cls}`, title: `${Math.round(p)}%` },
    h('span', { style: { width: `${p}%` } }));
}

// --------------------------------------------------------- toasts
export function toast(message, tone = '', ms = 4200) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast ${tone}` },
    h('span', {}, tone === 'danger' ? '⚠' : tone === 'good' ? '✓' : 'ℹ'),
    h('span', {}, message));
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
  return el;
}

// --------------------------------------------------------- modals
/*
 * Every modal currently on screen. A route change (browser Back, or any
 * navigation) must dismiss them: without this the dialog stayed open while the
 * page re-rendered underneath, leaving e.g. "Edit Ananya Shetty" floating over
 * the Students list, and the next Back walked further out of the app.
 */
const openModals = new Set();
window.addEventListener('hashchange', () => {
  for (const close of [...openModals]) close();
});

/**
 * Freeze the page behind an overlay.
 *
 * The class goes on `html`, not `body`. This stylesheet gives html
 * `overflow-y: scroll` to reserve the scrollbar gutter, and the viewport takes
 * its overflow from the root element — so html is the scroll container here and
 * a lock on body has no effect at all.
 *
 * Counted rather than boolean: a form can raise a confirm dialog on top of
 * itself, and the inner one closing must not hand the page back while the outer
 * one is still up.
 */
let scrollLocks = 0;
export function lockScroll() {
  scrollLocks += 1;
  document.documentElement.classList.add('scroll-locked');
}
export function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (!scrollLocks) document.documentElement.classList.remove('scroll-locked');
}

export function openModal({ title, body, footer, size = '', onClose }) {
  const host = document.getElementById('modals');
  const backdrop = h('div', { class: 'backdrop' });
  // close() reaches here from the × , Escape, the backdrop, a route change and
  // the caller's own ctl.close(). Guarding it keeps the scroll lock's count
  // honest — a double close would release the page one modal too early.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openModals.delete(close);
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    unlockScroll();
    if (onClose) onClose();
  };
  openModals.add(close);
  lockScroll();
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const modal = h('div', { class: `modal ${size}` },
    h('div', { class: 'modal-head' },
      h('h3', {}, title),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onClick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);

  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.appendChild(modal);
  host.appendChild(backdrop);
  setTimeout(() => {
    const first = modal.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
  }, 30);
  return { close, modal, backdrop };
}

export function confirmDialog({
  title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = false, requirePhrase,
}) {
  return new Promise((resolve) => {
    /*
     * openModal's close() fires onClose, and onClose resolves false. The confirm
     * button also closes the dialog, so without this guard the false from
     * onClose landed first and the caller's resolve(true) was discarded —
     * every confirmed delete silently did nothing.
     */
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };

    let phraseInput = null;
    const body = h('div', {},
      h('p', { style: { margin: '0 0 10px' } }, message),
      requirePhrase
        ? (phraseInput = h('input', {
          class: 'input', placeholder: `Type "${requirePhrase}" to confirm`,
        }))
        : null);

    const ok = h('button', {
      class: `btn ${danger ? 'danger' : 'primary'}`,
      onClick: () => {
        if (requirePhrase && phraseInput.value.trim() !== requirePhrase) {
          phraseInput.classList.add('invalid');
          toast(`Type "${requirePhrase}" exactly to confirm.`, 'warn');
          return;
        }
        settle(true);
        ctl.close();
      },
    }, confirmLabel);

    const ctl = openModal({
      title,
      size: 'narrow',
      body,
      footer: [h('button', { class: 'btn', onClick: () => { settle(false); ctl.close(); } }, 'Cancel'), ok],
      onClose: () => settle(false),
    });
  });
}

// ---------------------------------------------------------- forms
/** Same rules the server validates with, so the two never disagree. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Spacing and separators are the user's business; the digit count is not. */
const digitsOf = (v) => String(v).replace(/\D/g, '');
const PHONE_DIGITS = 10;

/**
 * A number box sitting on 0 turns "18" into "018" the moment someone types in
 * front of it. Selecting the 0 on focus lets the first keystroke replace it,
 * and the leading zero is stripped as a backstop for typing that lands
 * mid-value. A lone "0" and decimals like "0.5" are left alone.
 * Returns the input, so it can wrap one inline.
 */
export function noLeadingZero(input) {
  input.addEventListener('focus', () => { if (input.value === '0') input.select(); });
  input.addEventListener('input', () => {
    if (/^0\d/.test(input.value)) input.value = input.value.replace(/^0+(?=\d)/, '');
  });
  return input;
}

/**
 * What a select carries while the box underneath it holds the real answer.
 * Deliberately not a plain "other" — it can never collide with a record id or
 * an enum value, so a course genuinely named "Other" still round-trips.
 */
export const OTHER_VALUE = '__other__';

/**
 * Build a form from a field spec.
 * field: { name, label, type, options, required, span, hint, placeholder,
 *          value, min, max, step, rows, disabled, section }
 *
 * A select may also carry `other: { name, label, fieldLabel, placeholder,
 *   hint, error, also }` — an extra "Other" entry at the foot of the list that
 * opens a text box beneath it. Only one of the two is ever submitted: pick from
 * the list and `other.name` comes back empty; type instead and the select's own
 * value comes back empty. Nothing typed and then abandoned is ever saved.
 *
 * `other.also: { name, label, hint }` adds a tickbox under that text box — for
 * "and add this to the list for next time". It reads back as 1 or 0, and like
 * the text it only counts while Other is the visible answer.
 */
export function buildForm(fields, values = {}) {
  const wrap = h('div', { class: 'form-grid' });
  const controls = {};

  for (const f of fields) {
    if (!f) continue;
    if (f.type === 'section') { wrap.appendChild(h('div', { class: 'section' }, f.label)); continue; }
    if (f.type === 'node') { wrap.appendChild(h('div', { class: f.span ? 'span2' : '' }, f.node)); continue; }

    const raw = values[f.name] !== undefined ? values[f.name] : f.value;
    const val = raw == null ? '' : raw;
    let input;

    if (f.type === 'select') {
      input = h('select', { class: 'input', disabled: f.disabled });
      if (!f.required || f.placeholder) {
        input.appendChild(h('option', { value: '' }, f.placeholder || '— none —'));
      }
      for (const o of (f.options || [])) {
        const value = typeof o === 'object' ? String(o.value) : String(o);
        const label = typeof o === 'object' ? o.label : String(o);
        input.appendChild(h('option', { value }, label));
      }
      if (f.other) {
        input.appendChild(h('option', { value: OTHER_VALUE },
          f.other.label || 'Other — not in this list'));
      }
      input.value = String(val);
      if (input.value !== String(val) && val !== '') {
        // Value not in the option list (e.g. an archived record) — keep it visible.
        input.appendChild(h('option', { value: String(val) }, `${val} (inactive)`));
        input.value = String(val);
      }
      /*
       * Nothing matched — which for a required list with no placeholder means
       * assigning '' deselected every option, leaving a box that looks like it
       * is showing the first entry while reading back as empty. The form then
       * refuses to save over a field nobody can see is unset. Open on the first
       * real option instead, which is what the box appears to say anyway.
       */
      if (input.selectedIndex < 0 && input.options.length) input.selectedIndex = 0;
      /*
       * An answer that was typed rather than picked: nothing is stored in the
       * id, and the text beside it carries the whole of it. Reopening the
       * record has to land on Other, or the editor would show "not decided"
       * over a lead that plainly did decide.
       */
      if (f.other && !String(val)) {
        const typed = values[f.other.name] !== undefined ? values[f.other.name] : f.other.value;
        if (typed != null && String(typed).trim()) input.value = OTHER_VALUE;
      }
    } else if (f.type === 'textarea') {
      input = h('textarea', { class: 'input', rows: f.rows || 3, placeholder: f.placeholder || '', disabled: f.disabled });
      input.value = val;
    } else if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', checked: !!val && val !== '0', disabled: f.disabled });
      wrap.appendChild(h('div', { class: `field ${f.span ? 'span2' : ''}` },
        h('label', { class: 'check' }, input, f.label),
        f.hint ? h('div', { class: 'hint' }, f.hint) : null));
      controls[f.name] = { input, field: f };
      continue;
    } else if (f.type === 'checklist') {
      const chosen = new Set(String(val).split(',').map((s) => s.trim()).filter(Boolean));
      const boxes = (f.options || []).map((o) => {
        const cb = h('input', { type: 'checkbox', checked: chosen.has(o), value: o });
        return h('label', { class: 'check' }, cb, o);
      });
      input = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px' } }, boxes);
      input.__readChecklist = () =>
        $$('input', input).filter((b) => b.checked).map((b) => b.value).join(',');
    } else {
      const type = { money: 'number', tel: 'tel', email: 'email' }[f.type] || f.type || 'text';
      input = h('input', {
        class: 'input', type,
        placeholder: f.placeholder || '',
        min: f.min, max: f.max,
        step: f.step || (f.type === 'money' ? '0.01' : null),
        disabled: f.disabled,
        readOnly: f.readOnly,
      });
      input.value = val;
      if (type === 'number') noLeadingZero(input);
    }

    if (input.classList && !input.classList.contains('input') && f.type !== 'checklist') {
      input.classList.add('input');
    }

    const err = h('div', { class: 'err', style: { display: 'none' } });
    wrap.appendChild(h('div', { class: `field ${f.span ? 'span2' : ''}` },
      h('label', {}, f.label, f.required ? h('span', { class: 'req' }, ' *') : null),
      input,
      f.hint ? h('div', { class: 'hint' }, f.hint) : null,
      err));
    controls[f.name] = { input, err, field: f };

    /*
     * The write-in box for a select carrying `other`. It sits directly under
     * the list rather than always on show, so a form full of dropdowns does
     * not grow a spare empty box beside each one; picking Other reveals it and
     * puts the cursor in it, which is the only place there is left to type.
     */
    if (f.type === 'select' && f.other) {
      const o = f.other;
      const typed = values[o.name] !== undefined ? values[o.name] : o.value;
      const box = h('input', { class: 'input', type: 'text', placeholder: o.placeholder || '' });
      box.value = typed == null ? '' : typed;
      const otherErr = h('div', { class: 'err', style: { display: 'none' } });
      const alsoBox = o.also
        ? h('input', { type: 'checkbox', checked: !!values[o.also.name] && values[o.also.name] !== '0' })
        : null;
      const otherWrap = h('div', { class: `field ${f.span ? 'span2' : ''}` },
        h('label', {}, o.fieldLabel || f.label),
        box,
        o.hint ? h('div', { class: 'hint' }, o.hint) : null,
        alsoBox ? h('label', { class: 'check', style: { marginTop: '6px' } }, alsoBox, o.also.label) : null,
        alsoBox && o.also.hint ? h('div', { class: 'hint' }, o.also.hint) : null,
        otherErr);
      const sync = () => { otherWrap.style.display = input.value === OTHER_VALUE ? '' : 'none'; };
      sync();
      input.addEventListener('change', () => {
        sync();
        if (input.value === OTHER_VALUE) box.focus();
      });
      wrap.appendChild(otherWrap);
      controls[o.name] = {
        input: box,
        err: otherErr,
        field: { name: o.name, label: o.fieldLabel || f.label, otherOf: f.name },
      };
      if (alsoBox) {
        controls[o.also.name] = {
          input: alsoBox,
          field: { name: o.also.name, label: o.also.label, type: 'checkbox', otherOf: f.name },
        };
      }
    }
  }

  const read = () => {
    const out = {};
    for (const [name, c] of Object.entries(controls)) {
      const { input, field } = c;
      /*
       * Only the answer actually on screen counts. Typing "Advanced Excel",
       * thinking better of it and picking a listed course must not leave the
       * typing behind to be saved alongside — and the reverse, an id left over
       * from before Other was chosen, would win over what was just typed.
       */
      if (field.otherOf) {
        const live = controls[field.otherOf].input.value === OTHER_VALUE;
        if (field.type === 'checkbox') out[name] = live && input.checked ? 1 : 0;
        else out[name] = live ? input.value.trim() : '';
      } else if (field.type === 'select' && field.other && input.value === OTHER_VALUE) {
        out[name] = '';
      } else if (field.type === 'checkbox') out[name] = input.checked ? 1 : 0;
      else if (field.type === 'checklist') out[name] = input.__readChecklist();
      else if (field.type === 'number' || field.type === 'money') {
        out[name] = input.value === '' ? '' : Number(input.value);
      } else out[name] = input.value.trim ? input.value.trim() : input.value;
    }
    return out;
  };

  const clearErrors = () => {
    for (const c of Object.values(controls)) {
      if (!c.err) continue;
      c.err.style.display = 'none';
      c.input.classList.remove('invalid');
    }
  };

  const setErrors = (fieldErrors) => {
    clearErrors();
    let first = null;
    for (const [name, msg] of Object.entries(fieldErrors || {})) {
      const c = controls[name];
      if (!c || !c.err) continue;
      c.err.textContent = msg;
      c.err.style.display = '';
      c.input.classList.add('invalid');
      if (!first) first = c.input;
    }
    if (first) first.focus();
  };

  /**
   * Client-side checks so the server round-trip is not needed.
   * An email is only ever called invalid when it is non-empty and fails the
   * pattern — leaving an optional email blank is not an error.
   */
  const validate = () => {
    const values2 = read();
    const errors = {};
    for (const f of fields) {
      if (!f || f.type === 'section' || f.type === 'node') continue;
      const v = values2[f.name];
      const empty = v === '' || v == null;

      /*
       * With Other showing, the select's own value is empty by design and the
       * box under it holds the answer — so the required check belongs on the
       * box, not on the list it came from.
       */
      if (f.type === 'select' && f.other && controls[f.name].input.value === OTHER_VALUE) {
        if (!String(values2[f.other.name] || '').trim()) {
          errors[f.other.name] = f.other.error || 'Type it in, or pick one from the list';
        }
        continue;
      }

      if (f.required && empty) {
        if (f.type === 'email') errors[f.name] = 'Email is required';
        else if (f.type === 'tel') errors[f.name] = 'Phone number is required';
        else errors[f.name] = 'This field is required';
        continue;
      }
      if (f.type === 'email' && !empty && !EMAIL_RE.test(String(v))) {
        errors[f.name] = 'Invalid email address';
      }
      if (f.type === 'tel' && !empty && digitsOf(v).length !== PHONE_DIGITS) {
        errors[f.name] = 'Invalid phone number';
      }
    }
    if (Object.keys(errors).length) { setErrors(errors); return null; }
    clearErrors();
    return values2;
  };

  return { el: wrap, read, setErrors, clearErrors, validate, controls };
}

/** A modal wrapping buildForm, with submit/cancel plumbing and error routing. */
export function formModal({
  title, fields, values = {}, submitLabel = 'Save', size = '', onSubmit, extraFooter, onClose,
}) {
  const form = buildForm(fields, values);
  const submit = h('button', { class: 'btn primary' }, submitLabel);

  const doSubmit = async () => {
    const payload = form.validate();
    if (!payload) return;
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = 'Saving…';
    try {
      await onSubmit(payload, ctl, form);
    } catch (err) {
      handleError(err, form);
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  };

  submit.addEventListener('click', doSubmit);
  form.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); doSubmit(); }
  });

  const ctl = openModal({
    title, size, body: form.el, onClose,
    footer: [
      extraFooter || null,
      h('div', { style: { flex: '1' } }),
      h('button', { class: 'btn', onClick: () => ctl.close() }, 'Cancel'),
      submit,
    ],
  });
  ctl.form = form;
  return ctl;
}

/** Route an API error to inline field messages, or a toast if it has none. */
export function handleError(err, form) {
  if (err instanceof ApiError && err.fields && form) {
    form.setErrors(err.fields);
    toast(err.message, 'danger');
    return;
  }
  toast(err && err.message ? err.message : 'Something went wrong', 'danger', 6000);
  if (!(err instanceof ApiError)) console.error(err);
}

// ---------------------------------------------------------- table
/** Column alignment: 'right' for figures, 'center' to sit under its heading. */
const alignClass = (c) => (c.align === 'right' ? 'num' : c.align === 'center' ? 'ctr' : '');

/**
 * columns: [{ key, label, align, width, render(row), sortable, footer }]
 * Passing `render` gives full control; otherwise the raw value is printed.
 */
export function dataTable({
  columns, rows, onRow, empty = 'Nothing here yet', emptyHint, footer, rowClass,
}) {
  if (!rows || !rows.length) {
    return h('div', { class: 'dt-empty' },
      h('div', { class: 'big' }, '◍'),
      h('div', {}, empty),
      emptyHint ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, emptyHint) : null);
  }

  const table = h('table', { class: 'dt' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', {
      class: alignClass(c),
      style: c.width ? { width: c.width } : null,
    }, c.label)))),
    h('tbody', {}, rows.map((row, i) => {
      const tr = h('tr', {
        class: `${onRow ? 'clickable' : ''} ${rowClass ? rowClass(row) : ''}`.trim(),
      }, columns.map((c) => {
        const content = c.render ? c.render(row, i) : row[c.key];
        return h('td', { class: alignClass(c) || c.class || '' },
          content == null || content === '' ? h('span', { class: 'muted' }, '—') : content);
      }));
      if (onRow) {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input, select')) return;
          onRow(row);
        });
      }
      return tr;
    })),
    footer ? h('tfoot', {}, h('tr', {}, columns.map((c) => h('td', {
      class: alignClass(c),
    }, footer[c.key] == null ? '' : footer[c.key])))) : null);

  return h('div', { class: 'table-wrap' }, table);
}

// ------------------------------------------------------ page parts
export function pageHead(title, sub, actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
    actions ? h('div', { class: 'actions' }, actions) : null);
}

export function statTile({ label, value, sub, tone = '', onClick }) {
  return h('div', {
    class: `tile ${tone} ${onClick ? 'clickable' : ''}`.trim(),
    onClick: onClick || null,
  },
  h('div', { class: 'label' }, label),
  h('div', { class: 'value' }, value),
  sub ? h('div', { class: 'sub' }, sub) : null);
}

export const card = (title, body, opts = {}) => h('div', { class: 'card' },
  title ? h('div', { class: 'card-head' },
    h('div', {}, h('h3', {}, title), opts.sub ? h('div', { class: 'sub' }, opts.sub) : null),
    opts.right ? h('div', { class: 'right' }, opts.right) : null) : null,
  h('div', { class: `card-body ${opts.flush ? 'flush' : ''}` }, body));

export function tabs(items, active, onPick) {
  return h('div', { class: 'tabs' }, items.map((t) => h('button', {
    class: t.key === active ? 'active' : '',
    onClick: () => onPick(t.key),
  }, t.label, t.count != null ? h('span', { class: 'muted' }, ` ${t.count}`) : null)));
}

/* data-loading marks this as a placeholder so clear() knows the container is
   still waiting and must keep holding its height. */
export const loading = (msg = 'Loading…') =>
  h('div', { class: 'dt-empty loading-block', dataset: { loading: '1' } },
    h('div', { class: 'spinner', style: { margin: '0 auto 12px' } }), msg);

export const errorState = (msg, onRetry) => h('div', { class: 'dt-empty' },
  h('div', { class: 'big' }, '⚠'),
  h('div', {}, msg),
  onRetry ? h('button', { class: 'btn sm', style: { marginTop: '12px' }, onClick: onRetry }, 'Try again') : null);

/** Debounce for search inputs. */
export function debounce(fn, ms = 280) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const optionsFrom = (rows, valueKey = 'id', labelKey = 'name') =>
  (rows || []).map((r) => ({ value: r[valueKey], label: r[labelKey] }));
