'use strict';
/**
 * Adding a course from somewhere that is not the Courses screen.
 *
 * Both the enquiry form and the enrollment form let someone write in a course
 * that is not on the list yet, and both then need it to become a real course —
 * an enquiry so the next lead can simply pick it, an enrollment because
 * enrollments.course_id is NOT NULL and fees, batches and instalments all hang
 * off a genuine course row. The two would otherwise grow their own copy of this
 * with their own idea of what a code looks like.
 */

const { db } = require('./db');
const { canWrite, audit } = require('./auth');
const settings = require('./settings');
const { str, nowIso, forbidden } = require('./util');

/**
 * A code in the house style — initials and a number, like DA-101 or SQL-102.
 * Nobody is going to stop mid-form to invent one, and the column is UNIQUE, so
 * it is worked out here and can be changed later under Courses like any other
 * field.
 */
function courseCode(name) {
  const words = String(name).toUpperCase().match(/[A-Z]+/g) || [];
  // two or three initials read like the existing codes; a one-word name
  // borrows its own first letters instead, so it is not a lone character
  let stem = words.length > 1
    ? words.slice(0, 3).map((w) => w[0]).join('')
    : (words[0] || 'C').slice(0, 3);
  stem = stem.slice(0, 4) || 'C';
  for (let n = 101; n < 1000; n += 1) {
    const code = `${stem}-${n}`;
    if (!db.get('SELECT id FROM courses WHERE upper(code) = ?', [code])) return code;
  }
  return `${stem}-${Date.now().toString().slice(-6)}`;
}

/**
 * The course by this name, adding it if we do not run it yet.
 *
 * A name we already have is returned as it stands, however it was capitalised:
 * two courses with the same name and different codes would split every report
 * that groups by course, and would give the dropdown two entries that look
 * identical.
 *
 * Only the name is certain at the point this is called. Whatever else the form
 * knew — the fee it is charging, the GST rate — is taken as the course's
 * defaults; the rest is left to be filled in under Courses, which is far better
 * than the name being lost because six fields nobody has yet were demanded.
 */
function ensureCourse(user, name, { baseFee, taxPercent, note } = {}) {
  const clean = str(name);
  if (!clean) return null;

  const existing = db.get('SELECT * FROM courses WHERE lower(trim(name)) = lower(trim(?))', [clean]);
  if (existing) {
    return { id: existing.id, code: existing.code, name: existing.name, existing: true };
  }

  if (!canWrite(user, 'courses')) {
    throw forbidden(
      `Your role (${user.role}) cannot add a course. `
      + `Ask an admin to add "${clean}" to the course list, then try again.`,
    );
  }

  const code = courseCode(clean);
  const { lastInsertRowid: id } = db.run(
    `INSERT INTO courses (code, name, category, mode, duration_weeks, total_hours,
                          base_fee, tax_percent, description, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code, clean, null, 'Offline', 0, 0,
      Number(baseFee) || 0,
      taxPercent == null ? (Number(settings.get('default_tax_percent')) || 0) : Number(taxPercent),
      note || 'Added from a form — duration and modules still to be filled in.',
      1, nowIso(),
    ],
  );
  audit(user, 'create', 'courses', id, `${code} — ${clean} (added from a form)`);
  return { id: Number(id), code, name: clean, existing: false };
}

module.exports = { ensureCourse, courseCode };
