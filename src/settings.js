'use strict';
/** Key/value institute settings with sane defaults and number-series helpers. */

const { db } = require('./db');
const secretbox = require('./secretbox');
const { nowIso } = require('./util');

const DEFAULTS = {
  institute_name: 'Dhishaai Complete Analytics',
  tagline: 'Complete Analytics',
  address: '',
  city: '',
  phone: '',
  email: 'contactus@dhishaai.com',
  website: '',
  gstin: '',
  currency: '₹',
  currency_code: 'INR',
  academic_year: String(new Date().getFullYear()),
  reg_prefix: 'DA',
  receipt_prefix: 'RCPT',
  default_tax_percent: '18',   // GST, added on top of the fee after any discount
  fee_due_reminder_days: '7',

  /*
   * How mail leaves the building.
   *   smtp — a real mail server, needs the credentials below
   *   demo — nothing is sent; each message is captured and can be opened from
   *          Settings → Email → Demo outbox. Useful for showing the flow
   *          before a mailbox is set up.
   */
  mail_mode: 'smtp',

  // outgoing email — see src/mailer.js
  smtp_host: '',
  smtp_port: '587',
  smtp_secure: '',             // '1' forces TLS from the first byte (port 465)
  smtp_user: '',
  smtp_pass: '',
  smtp_from_name: '',
  smtp_from_email: '',

  // what goes out automatically when a new enquiry is logged
  enquiry_ack_enabled: '1',        // acknowledge the lead
  enquiry_notify_internal: '',     // and copy the institute inbox

  // ...and when a student is enrolled. {name} {course} {batch} {institute}
  // are substituted; the text is editable under Settings → Email.
  enroll_welcome_enabled: '1',
  enroll_welcome_subject: 'Welcome to DhishaAI Complete Analytics!',
  enroll_welcome_message: [
    'Hi,',
    '',
    'Welcome to DhishaAI Complete Analytics!',
    '',
    "We're excited to have you with us. We will keep you updated with the class",
    'schedule and other important announcements.',
    '',
    'Thank you, and welcome aboard!',
  ].join('\n'),

  /*
   * The second message a student gets: not "you are enrolled" but "this is the
   * morning to turn up". Sent by hand from Settings → Announcements once the
   * date is settled, so the wording is kept here and the sending is not.
   * {name} {course} {batch} {start_date} {time} {trainer} {mode} {institute}
   * are filled in per student; a line whose only value is empty is dropped.
   */
  class_start_subject: 'Your {course} classes begin on {start_date}',
  class_start_message: [
    'Hi {name},',
    '',
    'Your {course} training with {institute} begins on {start_date}.',
    '',
    'Batch: {batch}',
    'Timings: {time}',
    'Trainer: {trainer}',
    '',
    'Please be ready a few minutes early on the first day. If anything is',
    'unclear before then, simply reply to this email and we will help.',
    '',
    'See you in class!',
    '{institute}',
  ].join('\n'),

  terms: 'Fees once paid are non-refundable. Please retain this receipt for your records.',
};

function all() {
  const rows = db.all('SELECT key, value FROM settings');
  const out = { ...DEFAULTS };
  for (const r of rows) {
    out[r.key] = SECRET_KEYS.includes(r.key) ? secretbox.decrypt(r.value) : r.value;
  }
  return out;
}

/*
 * The mail password is the one setting that must never leave the server: both
 * /api/meta and /api/settings are readable by any signed-in user. It goes out
 * as a mask, and a mask coming back means "leave it as it is".
 */
const SECRET_KEYS = ['smtp_pass'];
const MASK = '••••••••';

/** Settings as the browser may see them. */
function publicAll() {
  const out = all();
  for (const k of SECRET_KEYS) if (out[k]) out[k] = MASK;
  return out;
}

const isMask = (v) => String(v) === MASK;

function get(key, fallback) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
  if (row) return SECRET_KEYS.includes(key) ? secretbox.decrypt(row.value) : row.value;
  return DEFAULTS[key] !== undefined ? DEFAULTS[key] : fallback;
}

function set(key, value) {
  const raw = value == null ? '' : String(value);
  // Credentials are sealed on the way in, so the column never holds the
  // readable text — including in every backup taken from here on.
  const stored = SECRET_KEYS.includes(key) ? secretbox.encrypt(raw) : raw;
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, stored, nowIso()],
  );
}

/**
 * Seal any credential still sitting in the clear from before this file grew an
 * encrypt step. Runs on boot; a no-op once everything is already sealed.
 */
function encryptExistingSecrets() {
  for (const key of SECRET_KEYS) {
    const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
    if (!row || !row.value || secretbox.isEncrypted(row.value)) continue;
    db.run('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?',
      [secretbox.encrypt(row.value), nowIso(), key]);
    console.log(`  Encrypted stored credential: ${key}`);
  }
}

/**
 * Next registration number, e.g. DA-2026-0042.
 * Derived from the highest existing suffix for this year so gaps never repeat.
 */
function nextRegNo() {
  const prefix = `${get('reg_prefix')}-${new Date().getFullYear()}-`;
  const last = db.get(
    'SELECT reg_no FROM students WHERE reg_no LIKE ? ORDER BY reg_no DESC LIMIT 1',
    [`${prefix}%`],
  );
  const n = last ? (parseInt(String(last.reg_no).slice(prefix.length), 10) || 0) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

/** Next receipt number, e.g. RCPT-2026-000137. */
function nextReceiptNo() {
  const prefix = `${get('receipt_prefix')}-${new Date().getFullYear()}-`;
  const last = db.get(
    'SELECT receipt_no FROM payments WHERE receipt_no LIKE ? ORDER BY receipt_no DESC LIMIT 1',
    [`${prefix}%`],
  );
  const n = last ? (parseInt(String(last.receipt_no).slice(prefix.length), 10) || 0) + 1 : 1;
  return prefix + String(n).padStart(6, '0');
}

module.exports = {
  DEFAULTS, SECRET_KEYS, MASK, isMask, all, publicAll, get, set, nextRegNo, nextReceiptNo,
  encryptExistingSecrets,
};
