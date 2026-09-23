'use strict';
/**
 * Tiny pattern router. Routes are declared as `/api/students/:id` and matched
 * into `ctx.params`. Handlers are plain functions that return a value (sent as
 * JSON) or a `raw()` envelope for CSV / file downloads.
 */

const { notFound } = require('./util');

const routes = [];

function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(seg.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
}

function add(method, pattern, handler, opts = {}) {
  const { regex, names } = compile(pattern);
  routes.push({ method, pattern, regex, names, handler, ...opts });
}

const router = {
  get: (p, h, o) => add('GET', p, h, o),
  post: (p, h, o) => add('POST', p, h, o),
  put: (p, h, o) => add('PUT', p, h, o),
  patch: (p, h, o) => add('PATCH', p, h, o),
  del: (p, h, o) => add('DELETE', p, h, o),
  list: () => routes,
};

function match(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  if (pathMatched) {
    const err = notFound('That endpoint does not accept this method');
    err.status = 405;
    throw err;
  }
  return null;
}

/** Wrap a non-JSON response body (CSV export, printable receipt, backup file). */
function raw(body, contentType, filename) {
  return {
    __raw: true,
    body,
    contentType: contentType || 'text/plain; charset=utf-8',
    filename,
  };
}

module.exports = { router, match, raw };
