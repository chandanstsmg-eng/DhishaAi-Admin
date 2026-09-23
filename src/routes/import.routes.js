'use strict';
/**
 * Importing an existing spreadsheet — read, map, preview, commit.
 *
 * The file is sent up with every step rather than parked on the server. It
 * keeps the flow honest: the preview and the commit both work from the bytes
 * the office is looking at, so there is no window in which a stale upload gets
 * imported instead of the file that was reviewed.
 */

const { db } = require('../db');
const { requireRole, audit } = require('../auth');
const { readWorkbook } = require('../sheet');
const importer = require('../importer');
const { str, badRequest } = require('../util');

/**
 * The uploaded file, however it arrived, as bytes.
 *
 * A file input gives a data: URL whose prefix carries the MIME type, and a
 * spreadsheet's type is a 60-character mouthful before the comma is even
 * reached — so the prefix is found by its shape, never by looking at a fixed
 * number of leading characters.
 */
function decode(body) {
  const data = str(body.data);
  if (!data) throw badRequest('No file was sent');
  const b64 = /^data:[^,]{0,200},/.test(data) ? data.slice(data.indexOf(',') + 1) : data;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw badRequest('That file came through empty');

  /*
   * An .xlsx is a ZIP and always starts "PK". Bytes that do not would still
   * parse as CSV — into nonsense rows that look like a sheet nobody filled in.
   * Better to say the upload was damaged than to show a preview of rubbish.
   */
  const name = str(body.filename).toLowerCase();
  if (name.endsWith('.xlsx') && !(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw badRequest('That .xlsx did not arrive intact. Try choosing it again — '
      + 'and if it keeps failing, open it in Excel and save a fresh copy.');
  }
  return buf;
}

function sheetOf(body) {
  let book;
  try {
    book = readWorkbook(decode(body), str(body.filename));
  } catch (err) {
    throw badRequest(err.message);
  }
  if (!book.length) throw badRequest('There are no sheets in that file');
  const wanted = str(body.sheet);
  const sheet = wanted ? book.find((s) => s.name === wanted) : book[0];
  if (!sheet) throw badRequest(`That file has no sheet called "${wanted}"`);
  if (!sheet.headers.length) throw badRequest(`"${sheet.name}" is empty`);
  return { book, sheet };
}

module.exports = function register(router) {
  /** What can be imported, and the columns each understands. */
  router.get('/api/import/targets', ({ user }) => {
    requireRole(user, 'admin');
    return { targets: importer.targetList() };
  });

  /** Open the file and describe it — sheets, headers, a few rows to look at. */
  router.post('/api/import/read', ({ user, body }) => {
    requireRole(user, 'admin');
    const book = (() => {
      try { return readWorkbook(decode(body), str(body.filename)); } catch (err) { throw badRequest(err.message); }
    })();
    return {
      sheets: book.map((s) => ({
        name: s.name,
        headers: s.headers,
        rows: s.rows.length,
        sample: s.rows.slice(0, 5),
      })),
    };
  });

  /**
   * What would happen, row by row. Writes nothing.
   *
   * The mapping is guessed when none is sent, so the first look is already
   * useful; whatever comes back can be corrected and sent again.
   */
  router.post('/api/import/preview', ({ user, body }) => {
    requireRole(user, 'admin');
    const target = str(body.target);
    if (!importer.TARGETS[target]) throw badRequest('Choose what this sheet holds first');
    const { book, sheet } = sheetOf(body);

    const guessed = importer.guessMapping(target, sheet.headers);
    const mapping = body.mapping && Object.keys(body.mapping).length ? body.mapping : guessed;

    const out = importer.run({
      target,
      rows: sheet.rows,
      mapping,
      commit: false,
      updateExisting: body.update_existing !== false,
    });

    return {
      sheet: sheet.name,
      sheets: book.map((s) => s.name),
      headers: sheet.headers,
      mapping,
      guessed,
      unmapped: sheet.headers.filter((hh) => !Object.values(mapping).includes(hh)),
      summary: out.summary,
      // enough to scroll through and judge; the summary counts every row
      rows: out.rows.slice(0, 300),
      truncated: Math.max(0, out.rows.length - 300),
    };
  });

  /**
   * Do it. One transaction: either every accepted row lands or none does, so a
   * failure halfway cannot leave the register half-imported.
   */
  router.post('/api/import/commit', ({ user, body }) => {
    requireRole(user, 'admin');
    const target = str(body.target);
    if (!importer.TARGETS[target]) throw badRequest('Choose what this sheet holds first');
    const { sheet } = sheetOf(body);
    const mapping = body.mapping && Object.keys(body.mapping).length
      ? body.mapping
      : importer.guessMapping(target, sheet.headers);

    const dry = importer.run({
      target, rows: sheet.rows, mapping, commit: false, updateExisting: body.update_existing !== false,
    });
    if (!dry.summary.create && !dry.summary.update) {
      throw badRequest('Not one row can be imported as it stands. Fix the sheet or the column mapping and look again.');
    }

    const out = db.tx(() => importer.run({
      target, rows: sheet.rows, mapping, commit: true, updateExisting: body.update_existing !== false,
    }));

    audit(user, 'create', 'import', null,
      `${target}: ${out.summary.create} created, ${out.summary.update} updated, `
      + `${out.summary.reject} rejected from ${str(body.filename) || sheet.name}`);

    return {
      ok: true,
      target,
      file: str(body.filename),
      sheet: sheet.name,
      summary: out.summary,
      rows: out.rows.filter((r) => r.action === 'reject').slice(0, 300),
    };
  });
};
