/**
 * Public landing page — a single screen, shown before anyone signs in.
 *
 * This is an internal admin tool, not a product being sold, so the landing page
 * says what the portal is and gets out of the way. It carries no figures: the
 * page is unauthenticated, and inventing sample numbers to fill a chart would
 * be untrue as well as pointless here.
 */

import { h, clear, openModal } from './ui.js';

const root = () => document.getElementById('root');

const POINTS = [
  { k: 'Recorded once', d: 'Enquiries, admissions, batches, fees and placements in a single register.' },
  { k: 'Reported live', d: 'Collections, ageing and conversion added up as the data goes in.' },
  { k: 'Ready to export', d: 'Every report leaves as CSV, every receipt prints.' },
];

function signUpNote(onLogin) {
  openModal({
    title: 'Need an account?',
    size: 'narrow',
    body: h('div', {},
      h('p', { style: { margin: '0 0 12px' } },
        'Accounts for this portal are created by your institute administrator from ',
        h('b', {}, 'Settings → Users'), '. There is no public sign-up.'),
      h('p', { class: 'muted', style: { margin: 0 } },
        'If you should have access, ask your admin to add you — or write to ',
        h('a', { href: 'mailto:contactus@dhishaai.com' }, 'contactus@dhishaai.com'), '.')),
    footer: h('button', { class: 'btn primary', onClick: onLogin }, 'Log in instead'),
  });
}

export function renderLanding(onLogin) {
  clear(root()).appendChild(h('div', { class: 'lp' },

    h('header', { class: 'lp-bar' },
      h('div', { class: 'lp-bar-inner' },
        h('span', { class: 'lp-logo' },
          h('img', { src: '/assets/img/dhishaai-logo.png', alt: 'Dhishaai Complete Analytics' })),
        h('div', { class: 'lp-bar-actions' },
          h('button', { class: 'btn ghost', onClick: onLogin }, 'Log in'),
          h('button', { class: 'btn primary', onClick: () => signUpNote(onLogin) }, 'Sign up')))),

    h('main', { class: 'lp-hero' },
      h('div', { class: 'lp-hero-grid' }),
      h('div', { class: 'lp-hero-inner' },
        // Sentence case in the markup, upper-cased by CSS — so it is copy that
        // can be read aloud and translated, not a shouted string.
        h('div', { class: 'lp-kicker' },
          h('span', { class: 'dot' }),
          'Built for Smarter Administration'),
        h('h1', {}, 'Real-Time Insights', h('br'), 'for ', h('span', {}, 'Better Decisions'), '.'),
        h('p', {}, 'Students, fees and placements kept in one system — so the numbers are already added up when you go looking for them.'),
        h('div', { class: 'lp-hero-cta' },
          h('button', { class: 'btn primary lg', onClick: onLogin }, 'Log in to your portal')),
        h('ul', { class: 'lp-points' },
          POINTS.map((p) => h('li', {},
            h('b', {}, p.k),
            h('span', {}, p.d)))))),

    h('footer', { class: 'lp-foot' },
      h('div', { class: 'lp-foot-inner' },
        h('span', {}, 'Dhishaai Complete Analytics'),
        h('span', {}, 'Staff access only')))));

  window.scrollTo(0, 0);
}
