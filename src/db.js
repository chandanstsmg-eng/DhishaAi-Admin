'use strict';
/**
 * SQLite access layer.
 *
 * Primary driver is Node's built-in `node:sqlite` (Node >= 22.5) so the whole
 * app installs with zero npm packages. If that is unavailable we fall back to
 * `better-sqlite3` should someone have installed it. Both drivers expose the
 * same synchronous prepare/run/get/all surface, so the adapter below is thin.
 *
 * Only POSITIONAL (?) parameters are used anywhere in this project — named
 * parameter syntax differs between the two drivers.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.DHISHAAI_DB || path.join(DATA_DIR, 'dhishaai.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function openDatabase() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return { handle: new DatabaseSync(DB_FILE), flavour: 'node:sqlite' };
  } catch (nodeErr) {
    try {
      const Better = require('better-sqlite3');
      return { handle: new Better(DB_FILE), flavour: 'better-sqlite3' };
    } catch (_) {
      const msg = [
        '',
        'Could not open a SQLite driver.',
        '',
        'This app uses Node\'s built-in SQLite, which needs Node.js 22.5 or newer.',
        `You are running Node ${process.version}.`,
        '',
        'Fix: install the current LTS from https://nodejs.org  then run  npm start',
        '',
        `(original error: ${nodeErr.message})`,
        '',
      ].join('\n');
      throw new Error(msg);
    }
  }
}

const { handle, flavour } = openDatabase();

handle.exec('PRAGMA journal_mode = WAL');
handle.exec('PRAGMA foreign_keys = ON');

/** node:sqlite can hand back BigInt for INTEGER columns; normalise to Number. */
function normalise(row) {
  if (row == null || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  }
  return row;
}

const db = {
  flavour,
  file: DB_FILE,

  /** Run raw SQL (migrations, pragmas). */
  exec(sql) {
    handle.exec(sql);
  },

  /** INSERT/UPDATE/DELETE -> { changes, lastInsertRowid } */
  run(sql, params = []) {
    const res = handle.prepare(sql).run(...params);
    return {
      changes: Number(res.changes ?? 0),
      lastInsertRowid: Number(res.lastInsertRowid ?? 0),
    };
  },

  /** First matching row, or undefined. */
  get(sql, params = []) {
    return normalise(handle.prepare(sql).get(...params));
  },

  /** All matching rows. */
  all(sql, params = []) {
    return handle.prepare(sql).all(...params).map(normalise);
  },

  /** Single scalar value from the first column of the first row. */
  scalar(sql, params = [], fallback = 0) {
    const row = db.get(sql, params);
    if (!row) return fallback;
    const v = Object.values(row)[0];
    return v == null ? fallback : v;
  },

  /**
   * Run `fn` inside a transaction. Nested calls reuse the outer transaction
   * (SQLite has no real nesting here, and every write path in this app is
   * short-lived, so a depth counter is enough).
   */
  tx(fn) {
    if (db._depth > 0) return fn();
    db._depth = 1;
    handle.exec('BEGIN');
    try {
      const out = fn();
      handle.exec('COMMIT');
      return out;
    } catch (err) {
      try { handle.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw err;
    } finally {
      db._depth = 0;
    }
  },
  _depth: 0,

  close() {
    try { handle.close(); } catch (_) { /* ignore */ }
  },
};

/**
 * Columns added to a table after it shipped. schema.sql only ever runs
 * CREATE TABLE IF NOT EXISTS, so an existing database file never picks up a
 * new column from it — every later addition has to be listed here too.
 */
const ADDED_COLUMNS = [
  ['enquiries', 'joined_on', 'TEXT'],
  ['enquiries', 'demo_on', 'TEXT'],
  ['enquiries', 'course_other', 'TEXT'],
];

/**
 * Move anyone still standing on a retired lifecycle stage onto the first one
 * that still exists.
 *
 * A stage dropped from the list does not stop existing in the database. The
 * pipeline board builds its columns from the list, so a student left on
 * "Admitted" would simply not appear on it — present in the register, absent
 * from the screen whose whole job is to show where everyone is. The move is
 * written to stage_history like any other, so the record says what happened and
 * when rather than the stage appearing to have changed by itself.
 *
 * Only rows still holding a retired value match, so this is a no-op from the
 * second boot onwards.
 */
function retireStages() {
  const C = require('./constants');
  if (!C.RETIRED_STAGES || !C.RETIRED_STAGES.length) return;
  const marks = C.RETIRED_STAGES.map(() => '?').join(',');
  const stranded = db.all(
    `SELECT id, stage FROM students WHERE stage IN (${marks})`, C.RETIRED_STAGES,
  );
  if (!stranded.length) return;

  const now = new Date().toISOString();
  db.tx(() => {
    for (const s of stranded) {
      db.run('UPDATE students SET stage = ?, updated_at = ? WHERE id = ?', [C.FIRST_STAGE, now, s.id]);
      db.run(
        `INSERT INTO stage_history (student_id, from_stage, to_stage, note, changed_by, changed_at)
         VALUES (?,?,?,?,?,?)`,
        [s.id, s.stage, C.FIRST_STAGE, `"${s.stage}" is no longer a stage`, 'system', now],
      );
    }
  });
  console.log(`  Moved ${stranded.length} student(s) off retired stages to ${C.FIRST_STAGE}.`);
}

/*
 * Settings that no longer control anything. A saved row outlives the setting
 * itself — the whole settings table is handed to the browser, so a dead key
 * would keep being sent and read as though something still honoured it.
 * Dropping the row is the honest end of it; nothing reads these keys now.
 */
const DROPPED_SETTINGS = ['low_seat_threshold'];

function dropRetiredSettings() {
  const marks = DROPPED_SETTINGS.map(() => '?').join(',');
  db.run(`DELETE FROM settings WHERE key IN (${marks})`, DROPPED_SETTINGS);
}

/** Create every table if missing. Safe to call on each boot. */
function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.all(`PRAGMA table_info(${table})`);
    if (cols.length && !cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  retireStages();
  dropRetiredSettings();
}

module.exports = { db, migrate, DB_FILE, DATA_DIR, ROOT };
