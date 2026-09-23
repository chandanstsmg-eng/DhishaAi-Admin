/** Application shell: auth gate, chrome, navigation and route wiring. */

import { api, setUnauthorizedHandler } from './api.js';
import {
  h, clear, fmt, toast, setCurrency, debounce, loading, errorState, formModal, confirmDialog,
  lockScroll, unlockScroll,
} from './ui.js';
import { route, startRouter, navigate, parseHash } from './router.js';
import { renderLanding as landingPage } from './landing.js';

import dashboard from './pages/dashboard.js';
import pipeline from './pages/pipeline.js';
import enquiries from './pages/enquiries.js';
import students from './pages/students.js';
import studentDetail from './pages/student-detail.js';
import courses from './pages/courses.js';
import batches from './pages/batches.js';
import enrollments from './pages/enrollments.js';
import followUps from './pages/follow-ups.js';
import fees from './pages/fees.js';
import payments from './pages/payments.js';
import attendance from './pages/attendance.js';
import staff from './pages/staff.js';
import placements from './pages/placements.js';
import tasks from './pages/tasks.js';
import expenses from './pages/expenses.js';
import reports from './pages/reports.js';
import settingsPage from './pages/settings.js';

// ------------------------------------------------------------- state
export const state = {
  user: null,
  meta: null,
  /** Reload the shared lookup payload (courses, batches, counts…). */
  async refreshMeta() {
    state.meta = await api.get('/api/meta');
    setCurrency(state.meta.settings.currency);
    renderNavCounts();
    return state.meta;
  },
  can(scope) {
    const scopes = (state.user && state.user.scopes) || [];
    return scopes.includes('*') || scopes.includes(scope);
  },
};

const root = () => document.getElementById('root');

// -------------------------------------------------------------- nav
const NAV = [
  { group: 'Overview', items: [
    { path: '/', label: 'Dashboard', icon: '▦' },
    { path: '/pipeline', label: 'Student pipeline', icon: '⇉' },
  ] },
  { group: 'Admissions', items: [
    // `link` carries the filter the badge is counting, so opening Enquiries
    // from here lists exactly those leads instead of the whole register and
    // leaving the two numbers to disagree. `path` stays clean for highlighting.
    // the size of the register, and the plain link to it — the badge and the
    // list it opens are the same number
    { path: '/enquiries', label: 'Enquiries', icon: '☎', count: 'enquiries_total' },
    { path: '/students', label: 'Students', icon: '☺', count: 'students' },
    { path: '/enrollments', label: 'Enrollments', icon: '✓' },
    { path: '/follow-ups', label: 'Follow-ups', icon: '☏', count: 'followups' },
  ] },
  { group: 'Academics', items: [
    { path: '/courses', label: 'Courses', icon: '▤' },
    { path: '/batches', label: 'Batches', icon: '▥' },
    { path: '/attendance', label: 'Attendance', icon: '☑' },
    { path: '/staff', label: 'Staff & trainers', icon: '♜' },
  ] },
  { group: 'Finance', items: [
    { path: '/fees', label: 'Fees & dues', icon: '₹', count: 'overdue' },
    { path: '/payments', label: 'Payments', icon: '▣' },
    { path: '/expenses', label: 'Expenses', icon: '▼' },
  ] },
  { group: 'Growth', items: [
    { path: '/placements', label: 'Placements', icon: '★' },
    { path: '/reports', label: 'Reports', icon: '◫' },
  ] },
  { group: 'Workspace', items: [
    { path: '/tasks', label: 'Tasks', icon: '✎', count: 'tasks' },
    { path: '/settings', label: 'Settings', icon: '⚙' },
  ] },
];

function renderNavCounts() {
  const counts = (state.meta && state.meta.counts) || {};
  for (const el of document.querySelectorAll('.nav a[data-count]')) {
    const n = counts[el.dataset.count] || 0;
    let pill = el.querySelector('.pill');
    if (!n) { if (pill) pill.remove(); continue; }
    if (!pill) {
      // Every badge looks the same. Follow-ups and Fees & dues used to be red;
      // two permanently red pills stopped reading as "look here" and just made
      // the sidebar noisy, so the number carries the urgency on its own.
      pill = h('span', { class: 'pill' });
      el.appendChild(pill);
    }
    // The exact figure, however big. "99+" hid the difference between a
    // hundred calls owed and four hundred, which is the difference between
    // a busy day and a backlog nobody has looked at.
    pill.textContent = n;
  }
}

/*
 * Badges follow the data, not the route. Saving, deleting or converting
 * anything reloads that screen but does not navigate, so the counts used to sit
 * one behind until you happened to click elsewhere — the list would say 36
 * enquiries under a badge still reading 35.
 *
 * Debounced, because one save can be several writes and they should cost one
 * refresh between them, not one each.
 */
let countsTimer = null;
window.addEventListener('dhishaai:changed', () => {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(() => { state.refreshMeta().catch(() => {}); }, 200);
});

function highlightNav(path) {
  for (const a of document.querySelectorAll('.nav a')) {
    // drop any query the link carries — a filtered link still points at the
    // same screen, and must still light up when you are on it
    const target = a.getAttribute('href').replace('#', '').split('?')[0];
    const active = target === '/'
      ? path === '/'
      : path === target || path.startsWith(`${target}/`);
    a.classList.toggle('active', active);
  }
}

// ------------------------------------------------------------ landing
/**
 * What the portal opens on. Signing in is a deliberate choice from here —
 * the form is not put in front of everyone who loads the page.
 */
function renderLanding() {
  landingPage(() => renderLogin());
}

// ------------------------------------------------------------ login
function renderLogin(message) {
  const email = h('input', { class: 'input', type: 'email', placeholder: 'you@dhishaai.com', autocomplete: 'username' });
  const password = h('input', { class: 'input', type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
  const err = h('div', { class: 'err', style: { display: 'none' } });
  const submit = h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center', marginTop: '4px' } }, 'Sign in');

  const go = async () => {
    err.style.display = 'none';
    if (!email.value.trim() || !password.value) {
      err.textContent = 'Enter your email and password.';
      err.style.display = '';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const out = await api.post('/api/auth/login', { email: email.value.trim(), password: password.value });
      state.user = out.user;
      await boot();
      toast(`Welcome back, ${out.user.name.split(' ')[0]}`, 'good');
    } catch (e) {
      err.textContent = e.message;
      err.style.display = '';
      password.value = '';
      password.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  };

  submit.addEventListener('click', go);
  for (const el of [email, password]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  clear(root()).appendChild(h('div', { class: 'login-page' },
    h('div', { class: 'login-card' },
      h('button', { class: 'login-back', onClick: () => renderLanding() }, '← Back'),
      h('div', { class: 'login-brand' },
        h('img', {
          src: '/assets/img/dhishaai-logo.png',
          alt: 'Dhishaai Complete Analytics',
        })),
      h('h2', {}, 'Sign in'),
      h('p', { class: 'muted' }, 'Use the admin account for your institute.'),
      message ? h('div', { class: 'alert info', style: { marginBottom: '16px' } }, message) : null,
      h('div', { class: 'field', style: { marginBottom: '13px' } }, h('label', {}, 'Email'), email),
      h('div', { class: 'field', style: { marginBottom: '13px' } }, h('label', {}, 'Password'), password),
      err,
      submit,
      h('div', { class: 'login-hint' },
        h('b', {}, 'First time here? '),
        'Sign in with ', h('code', {}, 'admin@dhishaai.com'), ' and the password printed in the terminal ',
        'when the server started, then change it from Settings → Users.'))));

  email.focus();
}

// ------------------------------------------------------------ shell
function renderShell() {
  const searchInput = h('input', {
    type: 'search', placeholder: 'Search students, receipts, batches…  (press /)', 'aria-label': 'Search',
  });
  const searchResults = h('div', { class: 'search-results', style: { display: 'none' } });

  const runSearch = debounce(async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) { searchResults.style.display = 'none'; return; }
    try {
      const { results } = await api.get('/api/search', { q });
      clear(searchResults);
      if (!results.length) {
        searchResults.appendChild(h('div', { style: { padding: '14px', color: 'var(--ink-3)' } }, `Nothing matches “${q}”`));
      } else {
        for (const r of results) {
          searchResults.appendChild(h('a', {
            href: r.link,
            onClick: () => { searchResults.style.display = 'none'; searchInput.value = ''; },
          },
          h('span', { class: 'k' }, r.type),
          h('div', { class: 't' }, r.title),
          h('div', { class: 's' }, r.subtitle)));
        }
      }
      searchResults.style.display = '';
    } catch (_) { /* search failures stay silent */ }
  });

  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('blur', () => setTimeout(() => { searchResults.style.display = 'none'; }, 180));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-brand' },
      h('img', { src: '/assets/img/dhishaai-logo.png', alt: 'Dhishaai Complete Analytics' })),
    h('nav', { class: 'nav' }, NAV.map((g) => h('div', {},
      h('div', { class: 'nav-group' }, g.group),
      g.items.map((it) => h('a', {
        href: `#${it.path}`,
        dataset: it.count ? { count: it.count } : {},
        onClick: () => setNav(false),
      },
      h('span', { class: 'ico' }, it.icon),
      h('span', {}, it.label)))))),
    h('div', { class: 'sidebar-foot' }, state.meta ? state.meta.settings.institute_name : 'Dhishaai'));

  /**
   * The navigation drawer, on anything narrower than 980px. Its open state
   * lives in three places — the panel, the dimmer and the scroll lock on the
   * body — so it is set from one place rather than toggled at each call site
   * and left half-applied.
   */
  const scrim = h('div', { class: 'scrim', onClick: () => setNav(false) });
  const menuBtn = h('button', {
    class: 'btn ghost icon menu-btn', title: 'Menu',
    'aria-label': 'Open navigation', 'aria-expanded': 'false',
    onClick: () => setNav(!document.body.classList.contains('nav-open')),
  }, '☰');

  let navOpen = false;
  function setNav(open) {
    // Signing out and back in builds a second shell; the document-level
    // listeners from the first one survive. Without this they would go on
    // scroll-locking the page on behalf of a sidebar no longer on it.
    if (!sidebar.isConnected || open === navOpen) return;
    navOpen = open;
    sidebar.classList.toggle('open', open);
    scrim.classList.toggle('show', open);
    document.body.classList.toggle('nav-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    // counted lock, shared with modals — closing the drawer must not hand the
    // page back while a dialog opened from it is still up
    if (open) lockScroll(); else unlockScroll();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setNav(false);
  });
  // Rotating a phone to landscape can cross the breakpoint with the drawer
  // open, which would leave the body scroll-locked under a sidebar that is
  // once again docked and permanent.
  const wide = window.matchMedia('(min-width: 981px)');
  wide.addEventListener('change', (e) => { if (e.matches) setNav(false); });

  /*
   * The drawer's slide is for the drawer opening, not for the window changing
   * size. Crossing the 980px breakpoint — by dragging the window edge, or by
   * zooming, which changes the CSS width just the same — re-applies the
   * off-screen transform, and the transition animated it: the sidebar visibly
   * slid left and right on every step of the resize.
   *
   * Transitions are switched off for the duration of the resize and restored
   * once it settles, so pressing the hamburger still animates.
   */
  let resizeSettle = null;
  window.addEventListener('resize', () => {
    document.documentElement.classList.add('resizing');
    clearTimeout(resizeSettle);
    resizeSettle = setTimeout(() => document.documentElement.classList.remove('resizing'), 180);
  });

  /**
   * Light / dark switch. Holds its own reference rather than re-querying the
   * topbar, so adding or reordering icon buttons can't leave it updating the
   * wrong one.
   */
  const themeGlyph = () => (document.documentElement.dataset.theme === 'dark' ? '☀' : '☾');
  const themeBtn = h('button', {
    class: 'btn ghost icon',
    title: 'Switch light / dark theme',
    'aria-label': 'Switch light / dark theme',
    onClick: () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('dhishaai-theme', next);
      themeBtn.textContent = themeGlyph();
      themeBtn.title = next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    },
  }, themeGlyph());

  const content = h('main', { class: 'content' });

  clear(root()).appendChild(h('div', { class: 'shell' },
    sidebar,
    scrim,
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        menuBtn,
        h('div', { class: 'search' },
          h('span', { class: 'ico' }, '⌕'), searchInput, searchResults),
        h('div', { class: 'topbar-spacer' }),
        themeBtn,
        h('button', { class: 'btn ghost icon', title: 'Change password', onClick: changePassword }, '🔑'),
        h('div', { class: 'user-chip' },
          h('div', { class: 'avatar' }, fmt.initials(state.user.name)),
          h('div', {},
            h('div', { class: 'n' }, state.user.name),
            h('div', { class: 'r' }, state.user.role))),
        h('button', { class: 'btn sm', onClick: confirmLogout }, 'Sign out')),
      content)));

  return content;
}

/** Ask first — Sign out sits next to the avatar and is easy to hit by mistake. */
async function confirmLogout() {
  const go = await confirmDialog({
    title: 'Sign out',
    message: `Sign out of the portal, ${state.user.name.split(' ')[0]}?`,
    confirmLabel: 'Sign out',
  });
  if (!go) return;
  await logout();
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch (_) { /* sign out locally regardless */ }
  state.user = null;
  renderLanding();
  // a toast, not a banner baked into the hero — it clears itself
  toast('You have been signed out.');
}

function changePassword() {
  formModal({
    title: 'Change your password',
    size: 'narrow',
    fields: [
      { name: 'current_password', label: 'Current password', type: 'password', required: true, span: true },
      { name: 'new_password', label: 'New password', type: 'password', required: true, span: true, hint: 'At least 8 characters.' },
      { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, span: true },
    ],
    submitLabel: 'Update password',
    async onSubmit(values, ctl, form) {
      if (values.new_password !== values.confirm) {
        form.setErrors({ confirm: 'The two passwords do not match' });
        return;
      }
      await api.post('/api/auth/password', values);
      ctl.close();
      toast('Password changed. Please sign in again.', 'good');
      setTimeout(() => renderLogin('Sign in with your new password.'), 900);
    },
  });
}

// ------------------------------------------------------------ routes
route('/', dashboard);
route('/pipeline', pipeline);
route('/enquiries', enquiries);
route('/enquiries/:id', enquiries);
route('/students', students);
route('/students/:id', studentDetail);
route('/courses', courses);
route('/courses/:id', courses);
route('/batches', batches);
route('/batches/:id', batches);
route('/enrollments', enrollments);
route('/follow-ups', followUps);
route('/fees', fees);
route('/payments', payments);
route('/payments/:id', payments);
route('/attendance', attendance);
route('/staff', staff);
route('/placements', placements);
route('/tasks', tasks);
route('/expenses', expenses);
route('/reports', reports);
route('/reports/:key', reports);
route('/settings', settingsPage);

// -------------------------------------------------------------- boot
let contentEl = null;

async function renderRoute(hit) {
  if (!contentEl) return;
  const { path } = parseHash();
  highlightNav(path);
  window.scrollTo(0, 0);

  if (!hit) {
    clear(contentEl).appendChild(errorState(
      `No screen matches “${path}”.`,
      () => navigate('/'),
    ));
    return;
  }

  /*
   * Hold the outgoing screen's height while the next one loads. Otherwise the
   * document shrinks to spinner-height and grows back a moment later, and that
   * collapse-and-rebound is what reads as the whole page lurching about.
   */
  const held = contentEl.offsetHeight;
  if (held) contentEl.style.minHeight = `${held}px`;
  const release = () => { contentEl.style.minHeight = ''; };

  clear(contentEl).appendChild(loading());
  try {
    const view = await hit.handler({ params: hit.params, query: hit.query, state });
    release();
    clear(contentEl).appendChild(view);
    // Counts may have shifted as a side-effect of the screen that just rendered.
    api.get('/api/meta').then((m) => { state.meta = m; renderNavCounts(); }).catch(() => {});
  } catch (err) {
    release();
    if (err && err.status === 401) return;
    console.error(err);
    clear(contentEl).appendChild(errorState(
      err.message || 'This screen could not be loaded.',
      () => renderRoute(hit),
    ));
  }
}

async function boot() {
  await state.refreshMeta();
  contentEl = renderShell();
  renderNavCounts();
  startRouter(renderRoute);
}

async function start() {
  const saved = localStorage.getItem('dhishaai-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.dataset.theme = 'dark';
  }

  setUnauthorizedHandler(() => {
    if (state.user) {
      state.user = null;
      renderLogin('Your session expired. Please sign in again.');
    }
  });

  try {
    const me = await api.get('/api/auth/me');
    if (!me.user) return renderLanding();
    state.user = { ...me.user, scopes: me.scopes };
    await boot();
  } catch (err) {
    clear(root()).appendChild(errorState(
      err.message || 'Cannot reach the server.',
      () => window.location.reload(),
    ));
  }
}

start();
