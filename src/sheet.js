'use strict';
/**
 * Reading a spreadsheet — .xlsx or .csv — into plain rows of text.
 *
 * An .xlsx file is a ZIP of XML parts, and Node can already unzip (node:zlib)
 * and we can already read XML well enough for a spreadsheet's very small
 * vocabulary. So this stays inside the project's no-dependencies rule rather
 * than pulling in a library that reads far more of the format than an import
 * ever needs.
 *
 * What it deliberately does not do: formulas (the cached result is used),
 * merged cells, formatting, or the old binary .xls. Those are told apart and
 * reported, not guessed at.
 */

const zlib = require('zlib');

// ------------------------------------------------------------------- ZIP
/**
 * The entries of a ZIP, by name.
 *
 * Read from the central directory at the end of the file rather than by
 * walking local headers from the front: a local header may say the sizes are
 * "in a trailing descriptor", and the central directory always knows.
 */
function unzip(buf) {
  const EOCD = 0x06054b50;
  let end = -1;
  // the comment field means the record is not necessarily the last 22 bytes
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end < 0) throw new Error('That file is not a valid .xlsx (no ZIP directory found).');

  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // the local header carries its own extra field, of its own length
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    try {
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch (_) { /* an unreadable part is simply absent */ }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ------------------------------------------------------------------- XML
const XML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function xmlText(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return XML_ENTITIES[code] !== undefined ? XML_ENTITIES[code] : whole;
  });
}

/** Every <tag ...>…</tag> or <tag ... /> at any depth, as raw strings. */
function elements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*?)?(/)?>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    if (m[2]) { out.push({ attrs: m[1] || '', inner: '' }); continue; }
    const close = xml.indexOf(`</${tag}>`, re.lastIndex);
    if (close < 0) break;
    out.push({ attrs: m[1] || '', inner: xml.slice(re.lastIndex, close) });
  }
  return out;
}

const attr = (attrs, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs || '');
  return m ? m[1] : null;
};

// ------------------------------------------------------------------ dates
/*
 * Excel keeps a date as a number of days since 30 December 1899 (the offset
 * that reproduces its deliberate 1900 leap-year bug). Whether a number is a
 * date is not in the cell — it is in the number format the cell points at, so
 * the styles part has to be read to tell 45000 the date from 45000 the fee.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map();
  for (const f of elements(stylesXml, 'numFmt')) {
    const id = Number(attr(f.attrs, 'numFmtId'));
    const code = attr(f.attrs, 'formatCode') || '';
    // a format with y/d, or m outside a [h]:mm time, is showing a date
    if (/[yd]/i.test(code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, ''))) custom.set(id, true);
  }
  const out = new Set();
  const xfs = elements(stylesXml, 'cellXfs')[0];
  if (!xfs) return out;
  elements(xfs.inner, 'xf').forEach((x, i) => {
    const id = Number(attr(x.attrs, 'numFmtId') || 0);
    if (BUILTIN_DATE_FORMATS.has(id) || custom.get(id)) out.add(i);
  });
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

/** Excel serial → YYYY-MM-DD, built from UTC parts so no timezone shifts it. */
function serialToDate(serial) {
  const days = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// --------------------------------------------------------------- cell refs
/** "BC7" → 54 (zero-based column). */
function colOf(ref) {
  let n = 0;
  for (const ch of String(ref)) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// -------------------------------------------------------------------- csv
/**
 * Split CSV, honouring quotes, doubled quotes inside them, embedded newlines
 * and CRLF. Also accepts semicolons and tabs, which is what Excel writes out
 * on a machine whose list separator is not a comma — a common surprise.
 */
function parseCsv(text) {
  const body = text.replace(/^﻿/, '');
  const head = body.slice(0, body.indexOf('\n') === -1 ? body.length : body.indexOf('\n'));
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of head) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && counts[ch] !== undefined) counts[ch]++;
  }
  const sep = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ------------------------------------------------------------------- xlsx
function readXlsx(buf) {
  const zip = unzip(buf);
  const text = (name) => (zip.has(name) ? zip.get(name).toString('utf8') : null);

  const shared = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst) {
    for (const si of elements(sst, 'si')) {
      // a string may be split into runs; the value is every <t> joined
      shared.push(elements(si.inner, 't').map((t) => xmlText(t.inner)).join(''));
    }
  }
  const dateXf = dateStyles(text('xl/styles.xml'));

  /* sheet name → part, via the workbook's relationships */
  const rels = new Map();
  const relsXml = text('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    for (const r of elements(relsXml, 'Relationship')) {
      rels.set(attr(r.attrs, 'Id'), String(attr(r.attrs, 'Target') || '').replace(/^\/?xl\//, ''));
    }
  }
  const wb = text('xl/workbook.xml') || '';
  const sheetDefs = elements(wb, 'sheet').map((s, i) => ({
    name: xmlText(attr(s.attrs, 'name') || `Sheet${i + 1}`),
    part: rels.get(attr(s.attrs, 'r:id')) || `worksheets/sheet${i + 1}.xml`,
  }));
  if (!sheetDefs.length) sheetDefs.push({ name: 'Sheet1', part: 'worksheets/sheet1.xml' });

  const sheets = [];
  for (const def of sheetDefs) {
    const xml = text(`xl/${def.part}`);
    if (!xml) continue;
    const rows = [];
    for (const r of elements(xml, 'row')) {
      const cells = [];
      for (const c of elements(r.inner, 'c')) {
        const ref = attr(c.attrs, 'r');
        const type = attr(c.attrs, 't');
        const style = Number(attr(c.attrs, 's') || -1);
        let value = '';
        if (type === 'inlineStr') {
          value = elements(c.inner, 't').map((t) => xmlText(t.inner)).join('');
        } else {
          const v = elements(c.inner, 'v')[0];
          const raw = v ? xmlText(v.inner) : '';
          if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') value = '';                 // #N/A and friends
          else if (raw !== '' && dateXf.has(style) && Number.isFinite(Number(raw))) {
            value = serialToDate(Number(raw));
          } else value = raw;
        }
        const at = ref ? colOf(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      const at = Number(attr(r.attrs, 'r') || rows.length + 1) - 1;
      while (rows.length < at) rows.push([]);
      rows[at] = cells;
    }
    sheets.push({ name: def.name, rows });
  }
  return sheets;
}

// ------------------------------------------------------------------- entry
const isXlsx = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
const isOldXls = (buf) => buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0;

/**
 * A file → [{ name, headers, rows }], where every value is a trimmed string.
 *
 * The first row holding anything is taken as the headers: people put a title
 * or a blank line above the table often enough that starting at row 1 blindly
 * would misread a good half of real spreadsheets.
 */
function readWorkbook(buffer, filename = '') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (isOldXls(buf)) {
    throw new Error('That is the older .xls format. Open it in Excel and use '
      + 'File → Save As → Excel Workbook (.xlsx), then upload that.');
  }

  const raw = isXlsx(buf)
    ? readXlsx(buf)
    : [{ name: filename || 'CSV', rows: parseCsv(buf.toString('utf8')) }];

  return raw.map((sheet) => {
    const rows = sheet.rows.map((r) => (r || []).map((c) => String(c ?? '').trim()));
    const headerAt = rows.findIndex((r) => r.some((c) => c !== ''));
    if (headerAt < 0) return { name: sheet.name, headers: [], rows: [] };

    const headers = rows[headerAt].map((hh, i) => (hh || `Column ${i + 1}`));
    const body = rows.slice(headerAt + 1)
      .filter((r) => r.some((c) => c !== ''))
      .map((r) => {
        const o = {};
        headers.forEach((hh, i) => { o[hh] = r[i] ?? ''; });
        return o;
      });
    return { name: sheet.name, headers, rows: body };
  });
}

module.exports = { readWorkbook, parseCsv, serialToDate };
