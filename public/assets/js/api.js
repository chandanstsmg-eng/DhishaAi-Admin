/** Thin fetch wrapper. Throws ApiError so callers can show field-level errors. */

export class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields || null;
  }
}

/** Set by app.js so a 401 anywhere bounces back to the sign-in screen. */
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch (_) {
    throw new ApiError(0, 'Cannot reach the server. Is it still running?');
  }

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (res.status === 204) { announce(method, path); return {}; }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }

  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.fields);
  announce(method, path);
  return data;
}

/**
 * Anything that is not a GET has changed something on the server, and the
 * sidebar badges are counts of exactly those things.
 *
 * Announced here rather than at each call site: adding an enquiry does not
 * change the route, so the badges — which only used to refresh when a route
 * rendered — kept the number from before the save. Every screen would have had
 * to remember to refresh them, and the one that forgot is the one that leaves a
 * stale count on the screen.
 */
function announce(method, path) {
  if (method === 'GET') return;
  window.dispatchEvent(new CustomEvent('dhishaai:changed', { detail: { method, path } }));
}

const qs = (params) => {
  if (!params) return '';
  const clean = Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== false);
  return clean.length ? `?${new URLSearchParams(clean)}` : '';
};

export const api = {
  get:  (path, params) => request('GET', path + qs(params)),
  post: (path, body) => request('POST', path, body || {}),
  put:  (path, body) => request('PUT', path, body || {}),
  del:  (path, body) => request('DELETE', path, body || {}),

  /** Trigger a browser download for a CSV / JSON export endpoint. */
  download(path, params) {
    const a = document.createElement('a');
    a.href = path + qs(params);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  /** Open a server-rendered page (receipt) in a new tab. */
  openTab(path) { window.open(path, '_blank', 'noopener'); },
};
