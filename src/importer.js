'use strict';
/**
 * Bringing an existing spreadsheet into the portal.
 *
 * The rule this is built around: nothing is written until the office has seen,
 * row by row, exactly what would happen. Every import runs twice — once as a
 * dry run that only reports, and once for real from the same code path, so the
 * preview cannot promise one thing and the commit do another.
 *
 * A row is never half-imported and never silently changed: it is created,
 * matched to an existing record and updated, or rejected with the reason in
 * words. Rejections are the point of the exercise, not a failure of it.
 */

const { db } = require('./db');
const settings = require('./settings');
const C = require('./constants');
const { serialToDate } = require('./sheet');
const { money, nowIso, today } = require('./util');

const pad = (n) => String(n).padStart(2, '0');
const clean = (v) => String(v == null ? '' : v).trim();

/** Headers and field names compared without case, spaces or punctuation. */
const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ------------------------------------------------------------------ values
/**
 * A date in any of the shapes a spreadsheet produces.
 *
 * Ambiguous slash dates are read day-first — 05/08/2026 is 5 August — because
 * that is how they are written here. A date that cannot be read is rejected
 * rather than guessed at: a wrong joining date is worse than a missing one.
 */
function toIsoDate(value) {
  const s = clean(value);
  if (!s) return '';

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return check(m[1], m[2], m[3]);

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? String(2000 + Number(m[3])) : m[3];
    // 13/05 can only be month-second, so day-first is not a guess there
    if (Number(m[1]) > 12 && Number(m[2]) <= 12) return check(year, m[2], m[1]);
    return check(year, m[2], m[1]);
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -,]*(\d{2,4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    const year = m[3].length === 2 ? String(2000 + Number(m[3])) : m[3];
    if (mo >= 0) return check(year, mo + 1, m[1]);
  }
  m = /^([A-Za-z]{3,})[ -](\d{1,2})[ -,]*(\d{2,4})$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const year = m[3].length === 2 ? String(2000 + Number(m[3])) : m[3];
    if (mo >= 0) return check(year, mo + 1, m[2]);
  }

  // an Excel serial that lost its formatting on the way through CSV
  if (/^\d{5}$/.test(s) && Number(s) > 20000 && Number(s) < 60000) return serialToDate(Number(s));

  return null;

  /** Only a date that survives the round trip is a real one — 31-02 is not. */
  function check(y, mo, d) {
    const iso = `${y}-${pad(Number(mo))}-${pad(Number(d))}`;
    const at = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(at.getTime())) return null;
    return at.getDate() === Number(d) && at.getMonth() + 1 === Number(mo) ? iso : null;
  }
}

/** "₹ 12,500.00" / "12500/-" → 12500 */
function toMoney(value) {
  const s = clean(value).replace(/[₹,\s]/g, '').replace(/\/-$/, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? money(n) : null;
}

const YES = new Set(['1', 'y', 'yes', 'true', 'active', 'enabled', 'on']);
const NO = new Set(['0', 'n', 'no', 'false', 'inactive', 'disabled', 'off']);

function toBool(value, fallback = 1) {
  const s = norm(value);
  if (!s) return fallback;
  if (YES.has(s)) return 1;
  if (NO.has(s)) return 0;
  return null;
}

/** Ten digits, however they were typed; +91 and 0 prefixes are dropped. */
function toPhone(value) {
  const digits = clean(value).replace(/\D/g, '');
  if (!digits) return '';
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? ten : null;
}

function toEmail(value) {
  const s = clean(value);
  if (!s) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

/** Match against a fixed list without caring about case or spacing. */
function toEnum(value, allowed) {
  const s = norm(value);
  if (!s) return '';
  const hit = allowed.find((a) => norm(a) === s);
  return hit || null;
}

// ------------------------------------------------------------------ lookups
const findCourse = (value) => {
  const s = norm(value);
  if (!s) return null;
  return db.all('SELECT id, code, name FROM courses')
    .find((c) => norm(c.code) === s || norm(c.name) === s) || null;
};

const findStaff = (value) => {
  const s = norm(value);
  if (!s) return null;
  return db.all('SELECT id, name FROM staff').find((r) => norm(r.name) === s) || null;
};

// ------------------------------------------------------------------ targets
/*
 * Each target names the columns it understands. `aliases` are what the same
 * thing tends to be called in a real office spreadsheet — the mapping is
 * guessed from these and then shown for correction, never applied blind.
 */
const TARGETS = {
  courses: {
    label: 'Courses',
    hint: 'The catalogue. Import this first — batches, students and fees all point at it.',
    fields: [
      { name: 'name', label: 'Course name', required: true, aliases: ['course', 'coursename', 'programme', 'program', 'title'] },
      { name: 'code', label: 'Course code', aliases: ['code', 'coursecode', 'shortcode'] },
      { name: 'category', label: 'Category', aliases: ['category', 'stream', 'type'] },
      { name: 'mode', label: 'Mode', type: 'enum', enumOf: C.MODES, aliases: ['mode', 'delivery'] },
      { name: 'duration_weeks', label: 'Duration (weeks)', type: 'int', aliases: ['duration', 'weeks', 'durationweeks'] },
      { name: 'total_hours', label: 'Total hours', type: 'int', aliases: ['hours', 'totalhours'] },
      { name: 'base_fee', label: 'Course fee', type: 'money', aliases: ['fee', 'coursefee', 'fees', 'amount', 'price', 'basefee'] },
      { name: 'tax_percent', label: 'GST %', type: 'money', aliases: ['gst', 'gstpercent', 'tax', 'taxpercent'] },
      { name: 'description', label: 'Description', aliases: ['description', 'about', 'details', 'notes'] },
      { name: 'active', label: 'Active', type: 'bool', aliases: ['active', 'status', 'enabled'] },
    ],
    find: (v) => (v.code && db.get('SELECT id, name FROM courses WHERE LOWER(code) = LOWER(?)', [v.code]))
      || db.get('SELECT id, name FROM courses WHERE LOWER(name) = LOWER(?)', [v.name]),
    label_of: (v) => v.name,
    insert(v) {
      const code = v.code || autoCode('courses', v.name);
      db.run(
        `INSERT INTO courses (code, name, category, mode, duration_weeks, total_hours,
                              base_fee, tax_percent, description, active, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [code, v.name, v.category || null, v.mode || 'Offline', v.duration_weeks || 0,
          v.total_hours || 0, v.base_fee || 0, v.tax_percent || 0, v.description || null,
          v.active === '' ? 1 : v.active, nowIso()],
      );
    },
    update(id, v) {
      applyUpdate('courses', id, v, ['name', 'category', 'mode', 'duration_weeks',
        'total_hours', 'base_fee', 'tax_percent', 'description', 'active']);
    },
  },

  staff: {
    label: 'Staff & trainers',
    hint: 'Trainers must exist before the batches that name them.',
    fields: [
      { name: 'name', label: 'Name', required: true, aliases: ['name', 'staffname', 'trainer', 'trainername', 'faculty'] },
      { name: 'designation', label: 'Designation', type: 'enum', enumOf: C.DESIGNATIONS, aliases: ['designation', 'role', 'post'] },
      { name: 'phone', label: 'Phone', type: 'phone', aliases: ['phone', 'mobile', 'contact', 'phoneno', 'mobileno'] },
      { name: 'email', label: 'Email', type: 'email', aliases: ['email', 'emailid', 'mail'] },
      { name: 'specialization', label: 'Specialisation', aliases: ['specialization', 'specialisation', 'subject', 'expertise'] },
      { name: 'join_date', label: 'Joined on', type: 'date', aliases: ['joindate', 'joinedon', 'doj', 'dateofjoining'] },
      { name: 'notes', label: 'Notes', aliases: ['notes', 'remarks'] },
      { name: 'active', label: 'Active', type: 'bool', aliases: ['active', 'status'] },
    ],
    find: (v) => db.get('SELECT id, name FROM staff WHERE LOWER(name) = LOWER(?)', [v.name]),
    label_of: (v) => v.name,
    insert(v) {
      db.run(
        `INSERT INTO staff (name, email, phone, designation, specialization, join_date, active, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [v.name, v.email || null, v.phone || null, v.designation || 'Trainer',
          v.specialization || null, v.join_date || null, v.active === '' ? 1 : v.active,
          v.notes || null, nowIso()],
      );
    },
    update(id, v) {
      applyUpdate('staff', id, v, ['name', 'email', 'phone', 'designation',
        'specialization', 'join_date', 'active', 'notes']);
    },
  },

  batches: {
    label: 'Batches',
    hint: 'Each batch names a course that must already exist.',
    fields: [
      { name: 'code', label: 'Batch code', required: true, aliases: ['code', 'batch', 'batchcode', 'batchname', 'batchid'] },
      { name: 'course', label: 'Course', required: true, type: 'ref', ref: 'course', aliases: ['course', 'coursename', 'coursecode', 'programme'] },
      { name: 'trainer', label: 'Trainer', type: 'ref', ref: 'staff', aliases: ['trainer', 'faculty', 'trainername', 'instructor'] },
      { name: 'mode', label: 'Mode', type: 'enum', enumOf: C.MODES, aliases: ['mode', 'delivery'] },
      { name: 'start_date', label: 'Starts on', type: 'date', aliases: ['startdate', 'start', 'startson', 'from', 'commencement'] },
      { name: 'end_date', label: 'Ends on', type: 'date', aliases: ['enddate', 'end', 'endson', 'to'] },
      { name: 'days', label: 'Days', aliases: ['days', 'schedule', 'classdays'] },
      { name: 'time_slot', label: 'Timings', aliases: ['time', 'timing', 'timings', 'timeslot', 'slot'] },
      { name: 'room', label: 'Room', aliases: ['room', 'hall', 'venue', 'classroom'] },
      { name: 'capacity', label: 'Capacity', type: 'int', aliases: ['capacity', 'seats', 'maxstudents', 'strength'] },
      { name: 'status', label: 'Status', type: 'enum', enumOf: C.BATCH_STATUS, aliases: ['status', 'batchstatus'] },
      { name: 'notes', label: 'Notes', aliases: ['notes', 'remarks'] },
    ],
    find: (v) => db.get('SELECT id, code AS name FROM batches WHERE LOWER(code) = LOWER(?)', [v.code]),
    label_of: (v) => v.code,
    insert(v) {
      db.run(
        `INSERT INTO batches (code, course_id, trainer_id, mode, start_date, end_date,
                              days, time_slot, room, capacity, status, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [v.code, v.course, v.trainer || null, v.mode || 'Offline', v.start_date || null,
          v.end_date || null, v.days || null, v.time_slot || null, v.room || null,
          v.capacity || 30, v.status || 'Planned', v.notes || null, nowIso()],
      );
    },
    update(id, v) {
      const map = { course: 'course_id', trainer: 'trainer_id' };
      applyUpdate('batches', id, v, ['course', 'trainer', 'mode', 'start_date', 'end_date',
        'days', 'time_slot', 'room', 'capacity', 'status', 'notes'], map);
    },
  },

  students: {
    label: 'Students',
    hint: 'The register. A registration number is generated for anyone who does not bring one.',
    fields: [
      { name: 'name', label: 'Name', required: true, aliases: ['name', 'studentname', 'fullname', 'student'] },
      { name: 'phone', label: 'Phone', required: true, type: 'phone', aliases: ['phone', 'mobile', 'contact', 'mobileno', 'phoneno', 'whatsapp'] },
      { name: 'reg_no', label: 'Registration no', aliases: ['regno', 'registrationno', 'registrationnumber', 'admissionno', 'rollno', 'id', 'studentid'] },
      { name: 'email', label: 'Email', type: 'email', aliases: ['email', 'emailid', 'mail'] },
      { name: 'alt_phone', label: 'Alternate phone', type: 'phone', aliases: ['altphone', 'alternatephone', 'phone2', 'secondarycontact'] },
      { name: 'dob', label: 'Date of birth', type: 'date', aliases: ['dob', 'dateofbirth', 'birthdate'] },
      { name: 'gender', label: 'Gender', aliases: ['gender', 'sex'] },
      { name: 'address', label: 'Address', aliases: ['address', 'addr'] },
      { name: 'city', label: 'City', aliases: ['city', 'town', 'place'] },
      { name: 'state', label: 'State', aliases: ['state'] },
      { name: 'pincode', label: 'Pincode', aliases: ['pincode', 'pin', 'zip', 'postalcode'] },
      { name: 'qualification', label: 'Qualification', aliases: ['qualification', 'education', 'degree'] },
      { name: 'college', label: 'College', aliases: ['college', 'university', 'institution', 'school'] },
      { name: 'passout_year', label: 'Passout year', aliases: ['passout', 'passoutyear', 'yearofpassing', 'batchyear'] },
      { name: 'experience', label: 'Experience', aliases: ['experience', 'workexperience', 'exp'] },
      { name: 'guardian_name', label: 'Guardian name', aliases: ['guardian', 'guardianname', 'parent', 'fathername', 'parentname'] },
      { name: 'guardian_phone', label: 'Guardian phone', type: 'phone', aliases: ['guardianphone', 'parentphone', 'parentcontact'] },
      { name: 'source', label: 'Source', type: 'enum', enumOf: C.SOURCES, aliases: ['source', 'leadsource', 'referredby', 'howdidyouhear'] },
      { name: 'status', label: 'Status', type: 'enum', enumOf: C.STUDENT_STATUS, aliases: ['status', 'studentstatus'] },
      { name: 'stage', label: 'Stage', type: 'enum', enumOf: C.STUDENT_STAGES, aliases: ['stage', 'pipeline', 'progress'] },
      { name: 'joined_on', label: 'Joined on', type: 'date', aliases: ['joinedon', 'joindate', 'doj', 'admissiondate', 'dateofjoining', 'enrolleddate', 'enrolledon'] },
      { name: 'notes', label: 'Notes', aliases: ['notes', 'remarks', 'comments'] },
    ],
    /*
     * Matched on the registration number first, then the phone, then the email.
     * Phone is what an office actually keys on — a student who reappears in a
     * later sheet without their number is a new row, and two people sharing a
     * number are the same person as far as the register is concerned.
     */
    find(v) {
      /*
       * A registration number that was supplied settles it either way: it
       * names an existing student, or it names a new one. Falling through to
       * the phone would merge two people who share a family number but have
       * separate registrations — the very thing a registration number is for.
       */
      if (v.reg_no) {
        return db.get('SELECT id, name FROM students WHERE LOWER(reg_no) = LOWER(?)', [v.reg_no]) || null;
      }
      return (v.phone && db.get('SELECT id, name FROM students WHERE phone = ?', [v.phone]))
        || (v.email && db.get('SELECT id, name FROM students WHERE LOWER(email) = LOWER(?)', [v.email]))
        || null;
    },
    label_of: (v) => v.name,
    insert(v) {
      db.run(
        `INSERT INTO students (reg_no, name, email, phone, alt_phone, dob, gender, address,
                               city, state, pincode, qualification, college, passout_year,
                               experience, guardian_name, guardian_phone, source, status,
                               stage, joined_on, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [v.reg_no || settings.nextRegNo(), v.name, v.email || null, v.phone,
          v.alt_phone || null, v.dob || null, v.gender || null, v.address || null,
          v.city || null, v.state || null, v.pincode || null, v.qualification || null,
          v.college || null, v.passout_year || null, v.experience || null,
          v.guardian_name || null, v.guardian_phone || null, v.source || null,
          v.status || 'Active', v.stage || C.FIRST_STAGE, v.joined_on || today(),
          v.notes || null, nowIso(), nowIso()],
      );
    },
    update(id, v) {
      applyUpdate('students', id, v, ['name', 'email', 'phone', 'alt_phone', 'dob', 'gender',
        'address', 'city', 'state', 'pincode', 'qualification', 'college', 'passout_year',
        'experience', 'guardian_name', 'guardian_phone', 'source', 'status', 'stage',
        'joined_on', 'notes'], {}, true);
    },
  },
};

/**
 * Update only the columns the sheet actually carried a value for.
 *
 * A spreadsheet that has no Email column must not empty everybody's email. A
 * blank cell in a column that IS present is likewise left alone — telling
 * "deliberately blank" from "not filled in yet" is beyond what a sheet says.
 */
function applyUpdate(table, id, values, columns, rename = {}, stamp = false) {
  const sets = [];
  const args = [];
  for (const col of columns) {
    const v = values[col];
    if (v === undefined || v === '' || v === null) continue;
    sets.push(`${rename[col] || col} = ?`);
    args.push(v);
  }
  if (stamp) { sets.push('updated_at = ?'); args.push(nowIso()); }
  if (!sets.length) return;
  args.push(id);
  db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, args);
}

/** A course code when the sheet had none — DAF-101, then -102 and so on. */
function autoCode(table, name) {
  const base = clean(name).split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4) || 'C';
  const used = new Set(db.all(`SELECT code FROM ${table}`).map((r) => String(r.code).toUpperCase()));
  for (let n = 101; n < 999; n++) {
    const code = `${base}-${n}`;
    if (!used.has(code)) return code;
  }
  return `${base}-${Date.now().toString().slice(-6)}`;
}

// ----------------------------------------------------------------- mapping
/** Guess which spreadsheet column is which field, for the office to correct. */
function guessMapping(target, headers) {
  const t = TARGETS[target];
  const out = {};
  const taken = new Set();
  for (const f of t.fields) {
    const wanted = [norm(f.name), norm(f.label), ...(f.aliases || [])];
    // an exact match on the whole header first, so "Guardian phone" does not
    // lose to "Phone" merely by appearing later in the sheet
    let hit = headers.find((hh) => !taken.has(hh) && wanted.includes(norm(hh)));
    if (!hit) hit = headers.find((hh) => !taken.has(hh) && wanted.some((w) => w.length > 3 && norm(hh).includes(w)));
    if (hit) { out[f.name] = hit; taken.add(hit); }
  }
  return out;
}

// -------------------------------------------------------------- the engine
/**
 * Read every row through the mapping and say what would happen to it.
 *
 * `commit` false is the preview; true does the writing. Same walk, same
 * decisions, same messages — the only difference is whether insert/update is
 * called at the end of each row.
 */
function run({ target, rows, mapping, commit = false, updateExisting = true }) {
  const t = TARGETS[target];
  if (!t) throw new Error(`Nothing here imports "${target}"`);

  const results = [];
  const summary = {
    create: 0, update: 0, reject: 0, skip: 0, total: rows.length,
  };
  // catches a phone or a code repeated further down the same sheet
  const seen = new Map();

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const line = i + 1;
    const values = {};
    const errors = {};
    const warnings = [];

    for (const f of t.fields) {
      const column = mapping[f.name];
      const cell = column ? raw[column] : '';
      const given = clean(cell);

      if (!given) {
        if (f.required && !(target === 'students' && f.name === 'reg_no')) {
          errors[f.name] = `${f.label} is needed and this row has none`;
        }
        values[f.name] = '';
        continue;
      }

      let out = given;
      switch (f.type) {
        case 'money': out = toMoney(given); break;
        case 'int': out = /^-?\d+$/.test(given.replace(/[,\s]/g, '')) ? Number(given.replace(/[,\s]/g, '')) : null; break;
        case 'date': out = toIsoDate(given); break;
        case 'phone': out = toPhone(given); break;
        case 'email': out = toEmail(given); break;
        case 'bool': out = toBool(given); break;
        case 'enum': out = toEnum(given, f.enumOf); break;
        case 'ref': {
          const hit = f.ref === 'course' ? findCourse(given) : findStaff(given);
          if (hit) out = hit.id;
          else if (f.required) out = null;
          else { out = ''; warnings.push(`No ${f.ref} called "${given}" — left unassigned`); }
          break;
        }
        default: out = given;
      }

      if (out === null) {
        errors[f.name] = {
          money: `"${given}" is not an amount`,
          int: `"${given}" is not a whole number`,
          date: `"${given}" is not a date that can be read`,
          phone: `"${given}" is not a ten-digit phone number`,
          email: `"${given}" is not an email address`,
          bool: `"${given}" is not a yes or no`,
          enum: `"${given}" is not one of: ${(f.enumOf || []).join(', ')}`,
          ref: `No ${f.ref} called "${given}" exists yet`,
        }[f.type] || `"${given}" cannot be used`;
        values[f.name] = '';
      } else values[f.name] = out;
    }

    const label = t.label_of(values) || `row ${line}`;

    /*
     * The same identity twice in one sheet.
     *
     * Checked even for a row that is already being rejected, and the key is
     * reserved by that row all the same. Two rows keyed on one phone number
     * cannot both be imported: the second would be matched to the first and
     * overwrite it, quietly turning two people into one. Better to say so and
     * let the office decide which is which.
     *
     * Siblings on a family phone are the ordinary case behind this — give them
     * a registration number each and both import, because a registration
     * number that is supplied is trusted over any other match.
     */
    const key = norm(values.reg_no || values.phone || values.code || values.name);
    if (key && seen.has(key)) {
      errors._duplicate = values.reg_no
        ? `Row ${seen.get(key)} has this same registration number`
        : `Row ${seen.get(key)} has this same ${values.phone ? 'phone number' : 'entry'}`
          + ' — give one of them their own number or a registration number, so they '
          + 'are not treated as the same person';
    } else if (key) seen.set(key, line);

    if (Object.keys(errors).length) {
      summary.reject++;
      results.push({ line, label, action: 'reject', errors, warnings, values });
      continue;
    }

    const existing = t.find(values);
    if (existing && !updateExisting) {
      summary.skip++;
      results.push({ line, label, action: 'skip', existing, warnings, values, errors: {} });
      continue;
    }

    if (existing) {
      summary.update++;
      results.push({ line, label, action: 'update', existing, warnings, values, errors: {} });
      if (commit) t.update(existing.id, values);
    } else {
      summary.create++;
      results.push({ line, label, action: 'create', warnings, values, errors: {} });
      if (commit) t.insert(values);
    }
  }

  return { target, summary, rows: results };
}

const targetList = () => Object.entries(TARGETS).map(([key, t]) => ({
  key,
  label: t.label,
  hint: t.hint,
  fields: t.fields.map((f) => ({
    name: f.name, label: f.label, required: !!f.required, type: f.type || 'text',
  })),
}));

module.exports = {
  TARGETS, targetList, guessMapping, run, toIsoDate, toMoney, toPhone,
};
