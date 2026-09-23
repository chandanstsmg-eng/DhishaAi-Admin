'use strict';
/**
 * Outgoing email over SMTP, written against node:net/node:tls so the project
 * keeps its zero-dependency rule.
 *
 * Deliberately small: one message at a time, AUTH LOGIN or PLAIN, implicit TLS
 * (port 465) or STARTTLS (587/25). That covers Gmail app passwords, Zoho,
 * Hostinger, Outlook and most shared hosting, which is all this app needs.
 *
 * Credentials live in the settings table, not in code — see Settings → Email.
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');

const TIMEOUT_MS = 20000;
const OUTBOX_DIR = path.join(__dirname, '..', 'data', 'outbox');

function config() {
  const s = settings.all();
  return {
    mode: s.mail_mode === 'demo' ? 'demo' : 'smtp',
    host: String(s.smtp_host || '').trim(),
    port: Number(s.smtp_port) || 587,
    user: String(s.smtp_user || '').trim(),
    pass: String(s.smtp_pass || ''),
    fromEmail: String(s.smtp_from_email || s.email || '').trim(),
    fromName: String(s.smtp_from_name || s.institute_name || '').trim(),
    // 465 speaks TLS from the first byte; 587 and 25 upgrade with STARTTLS
    implicitTls: String(s.smtp_secure || '') === '1' || Number(s.smtp_port) === 465,
  };
}

/** True once there is enough in Settings to attempt a send. */
function isConfigured() {
  const c = config();
  if (c.mode === 'demo') return true;      // demo mode needs no mail server
  return !!(c.host && c.fromEmail);
}

/**
 * Demo mode: keep the message instead of sending it, so the exact thing a
 * student would receive can be opened from the portal. One JSON file per
 * message, newest first by filename.
 */
function capture({ to, subject, text, html, attachments = [] }) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const c = config();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const record = {
    id,
    sent_at: new Date().toISOString(),
    from: c.fromName ? `${c.fromName} <${c.fromEmail || 'demo@localhost'}>` : (c.fromEmail || 'demo@localhost'),
    to,
    subject,
    text,
    html,
    attachments: attachments.map((a) => ({ filename: a.filename, bytes: Buffer.byteLength(a.content || '') })),
  };
  fs.writeFileSync(path.join(OUTBOX_DIR, `${id}.json`), JSON.stringify(record, null, 1), 'utf8');
  return { ok: true, demo: true, id };
}

/** Everything captured, newest first. */
function outbox(limit = 100) {
  if (!fs.existsSync(OUTBOX_DIR)) return [];
  return fs.readdirSync(OUTBOX_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort().reverse().slice(0, limit)
    .map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(OUTBOX_DIR, f), 'utf8'));
        return { id: r.id, sent_at: r.sent_at, to: r.to, subject: r.subject, from: r.from };
      } catch (_) { return null; }
    })
    .filter(Boolean);
}

/** One captured message in full, or null. */
function outboxItem(id) {
  const file = path.join(OUTBOX_DIR, `${String(id).replace(/[^\w.-]/g, '')}.json`);
  if (!file.startsWith(OUTBOX_DIR) || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function clearOutbox() {
  if (!fs.existsSync(OUTBOX_DIR)) return 0;
  const files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) fs.unlinkSync(path.join(OUTBOX_DIR, f));
  return files.length;
}

/** Header values must not carry newlines — that is how headers get injected. */
const headerSafe = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();

/** Non-ASCII in a header (an institute name, a subject) has to be encoded. */
function encodeHeader(value) {
  const v = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** Bodies go out base64 so long lines and UTF-8 survive intact. */
const b64Lines = (buf) => Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');

function buildMessage({ from, fromName, to, subject, text, html, attachments = [] }) {
  const boundary = `dhishaai_${crypto.randomBytes(12).toString('hex')}`;
  const altBoundary = `alt_${crypto.randomBytes(12).toString('hex')}`;
  const head = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${headerSafe(from)}>` : headerSafe(from)}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@dhishaai>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ];

  const body = [
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(text || ''),
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(html || ''),
    '',
    `--${altBoundary}--`,
    '',
  ];

  for (const a of attachments) {
    body.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${headerSafe(a.filename)}"`,
      '',
      b64Lines(a.content),
      '',
    );
  }
  body.push(`--${boundary}--`, '');

  return `${head.join('\r\n')}\r\n${body.join('\r\n')}`;
}

/**
 * Talk SMTP over an already-open socket. Each step waits for the reply code it
 * expects, so a refusal is reported with the server's own words rather than a
 * timeout.
 */
function converse(socket, steps, { greeting = true } = {}) {
  return new Promise((resolve, reject) => {
    // an SMTP server speaks first, so the greeting is a step that only waits
    const queue = greeting ? [{ expect: [220] }, ...steps] : [...steps];
    let buffer = '';
    let idx = -1;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      if (err) { socket.destroy(); reject(err); } else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('The mail server did not respond in time.')), TIMEOUT_MS,
    );

    /** Move to the next step, writing anything that needs writing. */
    const advance = () => {
      idx += 1;
      if (idx >= queue.length) { finish(); return; }
      const step = queue[idx];
      if (step.send != null) socket.write(`${step.send}\r\n`);
      if (!step.expect) advance();
    };

    socket.on('data', (chunk) => {
      if (done) return;
      buffer += chunk.toString('utf8');
      // a reply is complete when its last line reads "250 text", not "250-text"
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;
      buffer = '';
      const step = queue[idx];
      const code = Number(last.slice(0, 3));
      if (step && step.expect && !step.expect.includes(code)) {
        finish(new Error(`Mail server said: ${last.trim()}`));
        return;
      }
      advance();
    });
    socket.on('error', (err) => finish(new Error(`Mail server connection failed: ${err.message}`)));
    socket.on('close', () => finish(new Error('The mail server closed the connection.')));

    advance();
  });
}

/** Send one message. Rejects with a sentence fit to show the user. */
async function send({ to, subject, text, html, attachments }) {
  const c = config();
  // demo mode short-circuits before any network work
  if (c.mode === 'demo') return capture({ to, subject, text, html, attachments });
  if (!c.host) throw new Error('No SMTP host is set under Settings → Email.');
  if (c.host.includes('@')) {
    throw new Error(
      `"${c.host}" is an email address, not a mail server. Settings → Email → SMTP host `
      + 'wants something like smtp.gmail.com; the address belongs in Username and Send from.',
    );
  }
  if (!c.fromEmail) throw new Error('No "send from" address is set under Settings → Email.');

  const message = buildMessage({
    from: c.fromEmail, fromName: c.fromName, to, subject, text, html, attachments,
  });

  const socket = await new Promise((resolve, reject) => {
    const opts = { host: c.host, port: c.port, servername: c.host };
    const s = c.implicitTls ? tls.connect(opts) : net.connect(opts);
    const onReady = () => { s.removeListener('error', onError); resolve(s); };
    // some socket errors carry a code but no message; never report a blank reason
    const why = (err) => err.message || err.code || 'the connection failed';
    const onError = (err) => reject(new Error(`Could not reach ${c.host}:${c.port} — ${why(err)}`));
    s.once(c.implicitTls ? 'secureConnect' : 'connect', onReady);
    s.once('error', onError);
  });
  socket.setEncoding('utf8');

  const helo = { send: `EHLO ${c.fromEmail.split('@')[1] || 'localhost'}`, expect: [250] };

  const auth = c.user ? [
    { send: 'AUTH LOGIN', expect: [334] },
    { send: Buffer.from(c.user, 'utf8').toString('base64'), expect: [334] },
    { send: Buffer.from(c.pass, 'utf8').toString('base64'), expect: [235] },
  ] : [];

  const envelope = [
    { send: `MAIL FROM:<${c.fromEmail}>`, expect: [250] },
    { send: `RCPT TO:<${headerSafe(to)}>`, expect: [250, 251] },
    { send: 'DATA', expect: [354] },
    // a lone dot ends the message, so any such line in the body is escaped
    { send: `${message.replace(/\r?\n\./g, '\r\n..')}\r\n.`, expect: [250] },
    { send: 'QUIT', expect: [221] },
  ];

  if (c.implicitTls) {
    await converse(socket, [helo, ...auth, ...envelope]);
    return { ok: true };
  }

  // STARTTLS: greet, ask for the upgrade, swap in a secure socket, start over
  await converse(socket, [helo, { send: 'STARTTLS', expect: [220] }]);
  const secure = await new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: c.host }, () => resolve(s));
    s.once('error', (err) => reject(new Error(`TLS handshake failed: ${err.message}`)));
  });
  secure.setEncoding('utf8');
  // the upgraded connection is a fresh session, hence a second EHLO and no greeting
  await converse(secure, [helo, ...auth, ...envelope], { greeting: false });
  return { ok: true };
}

module.exports = {
  send, isConfigured, config, buildMessage, outbox, outboxItem, clearOutbox,
};
