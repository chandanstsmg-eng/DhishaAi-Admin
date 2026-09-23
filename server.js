'use strict';
/**
 * Dhishaai Admin Portal — HTTP server.
 * Built on node:http only; no third-party runtime dependencies.
 *
 *   npm start          -> http://localhost:4000
 *   PORT=8080 npm start
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const { db, migrate, DB_FILE } = require('./src/db');
const { router, match } = require('./src/router');
const auth = require('./src/auth');
const security = require('./src/security');
const { HttpError, unauthorized } = require('./src/util');
const { ensureSeeded } = require('./src/seed');

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024;         // 2 MB — any ordinary request
const MAX_UPLOAD = 25 * 1024 * 1024;      // 25 MB — a spreadsheet being imported

// ------------------------------------------------------------ boot
migrate();
ensureSeeded();
require('./src/settings').encryptExistingSecrets();
auth.purgeExpiredSessions();

// Every route module registers itself on the shared router.
for (const file of [
  'auth', 'dashboard', 'enquiries', 'students', 'courses', 'batches',
  'fees', 'enrollments', 'payments', 'attendance', 'staff', 'placements',
  'tasks', 'expenses', 'reports', 'announce', 'import', 'settings',
]) {
  require(`./src/routes/${file}.routes`)(router);
}

// ------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  // A stray "%" in the URL makes decodeURIComponent throw. That is a bad
  // request, not a server fault — answer 400 rather than letting it escape.
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch (_) {
    return send(res, 400, 'Bad request URL');
  }

  // Resolve inside PUBLIC_DIR only — blocks ../ traversal. The separator keeps
  // a sibling like "public-old" from passing a bare prefix test.
  let file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'Forbidden');
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Unknown non-asset path -> hand it to the single-page app.
    if (path.extname(rel)) return send(res, 404, 'Not found');
    file = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size}-${stat.mtimeMs.toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    // "no-cache" still caches — it just forces a revalidation first, which the
    // ETag above answers with a cheap 304. max-age let edited CSS and JS sit
    // stale in the browser, which is a bad trade for a self-hosted LAN app.
    'Cache-Control': 'no-cache',
  });

  // pipe() does not forward errors. A reload or a tab closed mid-download
  // aborts the socket, and an unhandled stream error would take the process
  // down with it — so both ends are wired up explicitly.
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ------------------------------------------------------------ helpers
function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new HttpError(400, 'Request body was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  // A junk request line should not reach the router, and must never throw out
  // of this handler — an async throw here is an unhandled rejection, which
  // Node treats as fatal.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return send(res, 400, 'Bad request URL');
  }
  const { pathname } = url;

  security.applyHeaders(req, res);

  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, pathname === '/' ? '/index.html' : pathname);
    }

    const hit = match(req.method, pathname);
    if (!hit) return sendJson(res, 404, { error: 'Unknown endpoint' });

    const { route, params } = hit;
    const user = auth.currentUser(req);
    if (!route.public && !user) throw unauthorized();

    /*
     * 2 MB is plenty for a form and mean enough to stop a runaway request.
     * A spreadsheet being imported is the one thing that legitimately arrives
     * large — base64 adds a third again on top of the file — so those routes,
     * and only those, are allowed a bigger body.
     */
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      ? await readBody(req, pathname.startsWith('/api/import/') ? MAX_UPLOAD : MAX_BODY)
      : {};

    const ctx = {
      req, res, user, params, body,
      query: Object.fromEntries(url.searchParams.entries()),
      // Whether this hop was TLS, so a session cookie can carry Secure when —
      // and only when — the browser will still send it back.
      secure: security.isSecureRequest(req),
      setCookie: (v) => res.setHeader('Set-Cookie', v),
    };

    const out = await route.handler(ctx);

    if (out && out.__raw) {
      const headers = { 'Content-Type': out.contentType, 'Cache-Control': 'no-store' };
      if (out.filename) headers['Content-Disposition'] = `attachment; filename="${out.filename}"`;
      res.writeHead(200, headers);
      return res.end(out.body);
    }
    return sendJson(res, out === undefined ? 204 : 200, out === undefined ? {} : out);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[${status}] ${req.method} ${pathname}`, err);
    // A client that walked away mid-response leaves nothing to reply to.
    if (res.headersSent || res.writableEnded) return res.destroy();
    return sendJson(res, status, {
      error: status >= 500 ? 'Something went wrong on the server' : err.message,
      fields: err.fields || undefined,
    }, err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {});
  }
});

/** Every LAN address this machine answers on, for the banner below. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error('  Either the portal is already running in another window, or');
    console.error(`  another program has the port. Start on a free one with:\n`);
    console.error(`      set PORT=4100 && npm start\n`);
    process.exit(1);
  }
  console.error('\n  The server could not start:', err);
  process.exit(1);
});

// 0.0.0.0 — this machine plus anyone else on the same Wi-Fi.
server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  DHISHAAI  ·  Admin Portal');
  console.log(line);
  console.log(`  This PC   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  Same WiFi http://${ip}:${PORT}`);
  }
  console.log(`  Database  ${DB_FILE}`);
  console.log(`  Driver    ${db.flavour}`);
  console.log(`  Node      ${process.version}`);
  console.log(`${line}\n  Press Ctrl+C to stop.\n`);
});

/*
 * A fault that escapes every handler means the process is in a state nobody
 * reasoned about — a half-finished transaction, a released handle, a module
 * left mid-update. Carrying on from there risks writing wrong data to the
 * register, which is worse than a ten-second outage.
 *
 * So: log it, stop taking new work, let the responses already in flight finish,
 * and exit non-zero for the service manager to restart on. STAY_UP=1 restores
 * the previous log-and-continue behaviour for anyone running this by hand with
 * no supervisor in front of it.
 */
const STAY_UP = process.env.STAY_UP === '1';
let faulting = false;

function onFatal(label, err) {
  console.error(`[${label}]`, err);
  if (STAY_UP || faulting) return;
  faulting = true;
  console.error('  Restarting — the service manager will bring this back up.');
  try { server.close(); } catch (_) { /* already closing */ }
  /*
   * Give in-flight responses a moment, then go regardless.
   *
   * Deliberately NOT unref'd: closing the listener can empty the event loop on
   * its own, and an unref'd timer would let the process fall off the end with
   * status 0 before this fires — which a service manager reads as a clean stop
   * and does not restart. Holding the loop open until the exit below is what
   * makes the failure visible.
   */
  setTimeout(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    process.exit(1);
  }, 1500);
}

process.on('uncaughtException', (err) => onFatal('uncaught', err));
process.on('unhandledRejection', (err) => onFatal('unhandled rejection', err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nShutting down…');
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
