/** Hash router: "#/students/12?tab=fees" -> { path, params, query }. */

const routes = [];

export function route(pattern, handler) {
  const names = [];
  const src = pattern.split('/').map((seg) => {
    if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(seg.slice(1));
    return '([^/?]+)';
  }).join('/');
  routes.push({ regex: new RegExp(`^${src}/?$`), names, handler, pattern });
}

export function parseHash(hash = window.location.hash) {
  const raw = (hash || '#/').replace(/^#/, '') || '/';
  const [path, search] = raw.split('?');
  return {
    path: path || '/',
    query: Object.fromEntries(new URLSearchParams(search || '')),
  };
}

export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
}

/** Rewrite the query string without adding a history entry or re-rendering. */
export function setQuery(patch) {
  const { path, query } = parseHash();
  const next = { ...query, ...patch };
  for (const k of Object.keys(next)) {
    if (next[k] === '' || next[k] == null || next[k] === false) delete next[k];
  }
  const search = new URLSearchParams(next).toString();
  window.history.replaceState(null, '', `#${path}${search ? `?${search}` : ''}`);
}

export function resolve(hash) {
  const { path, query } = parseHash(hash);
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params, query, path };
  }
  return null;
}

let current = null;
export const currentRoute = () => current;

export function startRouter(render) {
  const run = () => {
    const hit = resolve(window.location.hash);
    current = hit;
    render(hit);
  };
  window.addEventListener('hashchange', run);
  run();
}
