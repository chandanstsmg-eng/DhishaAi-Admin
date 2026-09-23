'use strict';
/** Shared helpers: money, dates, validation, CSV, HTTP errors. */

// ------------------------------------------------------------------ errors
class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}
const badRequest = (msg, fields) => new HttpError(400, msg, fields);
const unauthorized = (msg = 'Please sign in') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission for this') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

// ------------------------------------------------------------------- money
/** Round to 2 decimals, tolerating strings / null / NaN. */
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

// ------------------------------------------------------------------- dates
const pad = (n) => String(n).padStart(2, '0');

/** Local (not UTC) YYYY-MM-DD for a Date or ISO-ish string. */
function toDate(d) {
  const x = d ? new Date(d) : new Date();
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
const today = () => toDate(new Date());
const nowIso = () => new Date().toISOString();

function addDays(dateStr, days) {
  const d = new Date(dateStr || today());
  d.setDate(d.getDate() + Number(days || 0));
  return toDate(d);
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–99 in words. */
function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
}

/** 0–999 in words. */
function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}

/**
 * An amount spelled out the Indian way — crore, lakh, thousand — for the
 * "In Words" line every receipt carries. Paise are named separately so a
 * rounded figure is never quietly presented as an exact one.
 */
function rupeesInWords(amount) {
  const v = Math.abs(money(amount));
  const whole = Math.floor(v);
  const paise = Math.round((v - whole) * 100);

  const parts = [];
  const crore = Math.floor(whole / 10000000);
  const lakh = Math.floor((whole % 10000000) / 100000);
  const thousand = Math.floor((whole % 100000) / 1000);
  const rest = whole % 1000;
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));

  const words = parts.length ? parts.join(' ') : 'Zero';
  const tail = paise ? ` and ${twoDigits(paise)} Paise` : '';
  return `Rupees ${words}${tail} Only.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A batch is named by its code — DA-101-2026C — which is what the office and
 * the student both quote. The start date stands in only if a batch somehow has
 * no code; it is read straight off the ISO string rather than through Date, so
 * the day never shifts by a timezone.
 */
function batchLabel(startDate, code) {
  if (code) return code;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startDate || ''));
  return m ? `${m[3]}${MONTHS[Number(m[2]) - 1]}${m[1]}` : '';
}

function monthStart(d) {
  const x = new Date(d || today());
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-01`;
}

/** ["2026-02", "2026-03", ...] ending at the current month. */
/**
 * Every calendar month a date range touches, oldest first, as YYYY-MM. Used to
 * lay out a monthly report so months with nothing in them still appear as a
 * zero — a gap in the bars is a fact about the business, and dropping the row
 * would quietly redraw it as a shorter year.
 *
 * The iteration is capped rather than trusting the dates: a mistyped year in a
 * query string would otherwise ask for tens of thousands of rows.
 */
function monthsBetween(from, to) {
  const out = [];
  const [fy, fm] = String(from).slice(0, 7).split('-').map(Number);
  const [ty, tm] = String(to).slice(0, 7).split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return out;
  let y = fy;
  let m = fm;
  for (let i = 0; i < 600 && (y < ty || (y === ty && m <= tm)); i += 1) {
    out.push(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function lastNMonths(n) {
  const out = [];
  const x = new Date();
  x.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(x.getFullYear(), x.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  return out;
}

const daysBetween = (a, b) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

// -------------------------------------------------------------- validation
const str = (v) => (v == null ? '' : String(v).trim());

function required(body, fields) {
  const missing = fields.filter((f) => !str(body[f]));
  if (missing.length) {
    throw badRequest(
      `Required: ${missing.join(', ')}`,
      Object.fromEntries(missing.map((f) => [f, 'This field is required'])),
    );
  }
}

/*
 * Validate what will actually be stored. `str()` trims before the value goes
 * into the row, so testing the raw body would reject " a@b.com " as malformed
 * and then save the perfectly good trimmed version.
 */
const isEmail = (v) => { const s = str(v); return !s || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); };
/* Exactly ten digits. Spaces, dashes and brackets are ignored so a number can
 * be typed the way it is written down, but the digit count is not negotiable. */
const isPhone = (v) => { const s = str(v); return !s || s.replace(/\D/g, '').length === 10; };

/** Keep only the whitelisted keys from an incoming body. */
function pick(body, keys) {
  const out = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

/** Guard a value against an allowed set, falling back to the first entry. */
function oneOf(value, allowed, fallback) {
  const v = str(value);
  return allowed.includes(v) ? v : (fallback ?? allowed[0]);
}

const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

// --------------------------------------------------------------- SQL build
/**
 * Build "SET a = ?, b = ?" plus the ordered value list from a plain object.
 * Returns null when there is nothing to update.
 */
function buildUpdate(obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return null;
  return {
    clause: keys.map((k) => `${k} = ?`).join(', '),
    values: keys.map((k) => obj[k]),
  };
}

function buildInsert(table, obj) {
  const keys = Object.keys(obj);
  return {
    sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    values: keys.map((k) => obj[k]),
  };
}

// ---------------------------------------------------------------- CSV
function toCsv(rows, columns) {
  if (!rows.length && !columns) return '';
  const cols = columns || Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map((c) => esc(c.label || c)).join(',');
  const body = rows
    .map((r) => cols.map((c) => esc(r[c.key || c])).join(','))
    .join('\r\n');
  return `${head}\r\n${body}`;
}

// ---------------------------------------------------------------- misc
/** Next sequential code, e.g. nextCode('DA-STU-', 'students', 'reg_no'). */
function padSeq(prefix, n, width = 4) {
  return `${prefix}${String(n).padStart(width, '0')}`;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));

module.exports = {
  HttpError, badRequest, unauthorized, forbidden, notFound, conflict,
  money, toDate, today, nowIso, addDays, monthStart, lastNMonths, monthsBetween,
  daysBetween, batchLabel,
  rupeesInWords,
  str, required, isEmail, isPhone, pick, oneOf, bool,
  buildUpdate, buildInsert, toCsv, padSeq, clamp,
};
