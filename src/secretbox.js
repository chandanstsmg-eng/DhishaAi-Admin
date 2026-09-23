'use strict';
/**
 * Encryption at rest for the handful of settings that are credentials.
 *
 * The mail password has to be replayed verbatim to the SMTP server, so it
 * cannot be hashed the way a user password is — it has to be recoverable. What
 * it should not be is readable in a copied database file, and a .db lands in
 * ordinary places: a backup drive, an email to whoever is helping, a USB stick.
 * AES-256-GCM with a key kept outside the database separates the two: taking
 * the file is no longer the same as taking the mailbox.
 *
 * The key comes from DHISHAAI_SECRET when set — the right answer on a server,
 * because it keeps the key out of the data directory entirely. Failing that a
 * key file is generated next to the database and locked down, which keeps this
 * working with no setup at all.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

let cachedKey = null;

function keyFile() {
  const { DATA_DIR } = require('./db');
  return path.join(DATA_DIR, '.secret-key');
}

/**
 * 32-byte key from the environment, or a generated one on disk.
 * Read once and held — this is called on every settings read.
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = String(process.env.DHISHAAI_SECRET || '').trim();
  if (fromEnv) {
    // Any passphrase length is accepted; a hash gives the 32 bytes AES needs.
    cachedKey = crypto.createHash('sha256').update(fromEnv, 'utf8').digest();
    return cachedKey;
  }

  const file = keyFile();
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (hex.length >= 64) {
      cachedKey = Buffer.from(hex.slice(0, 64), 'hex');
      return cachedKey;
    }
  } catch (_) { /* not created yet */ }

  const key = crypto.randomBytes(32);
  // mode 0600 is honoured on Linux; on Windows the ACL is set by
  // deploy/harden-permissions.ps1, which the deployment guide runs.
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** "enc:v1:<iv>:<tag>:<ciphertext>", all base64. */
function encrypt(plain) {
  const text = plain == null ? '' : String(plain);
  if (!text) return '';
  if (isEncrypted(text)) return text;            // already sealed
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, body].map((b) => b.toString('base64')).join(':');
}

/**
 * Reverse of the above. A value with no prefix is from before this existed and
 * is handed back untouched; a value that will not open (wrong key, truncated
 * copy) returns empty rather than throwing, so one unreadable credential cannot
 * stop the whole settings page from loading.
 */
function decrypt(stored) {
  const text = stored == null ? '' : String(stored);
  if (!text || !isEncrypted(text)) return text;
  try {
    const [ivB, tagB, bodyB] = text.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyB, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_) {
    console.error('[secrets] A stored credential could not be decrypted — re-enter it under Settings → Email.');
    return '';
  }
}

module.exports = { encrypt, decrypt, isEncrypted, PREFIX, keyFile };
