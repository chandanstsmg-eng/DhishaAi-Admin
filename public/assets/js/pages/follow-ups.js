import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, clear, loading,
  statTile, todayStr, buildForm,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';

/**
 * The day's call list.
 *
 * Two queues, missed first: a call promised yesterday and not made is the one
 * costing a lead, so it sits above today's work rather than below it. Logging a
 * call from here reschedules the next one, which is what takes a row off the
 * list — so the screen empties as the day is worked through.
 *
 * The Show filter narrows that to a single day. Everything it can offer comes
 * from one fetch that reaches a day ahead, so switching between yesterday,
 * today and tomorrow is instant and never disagrees with the totals above it.
 */

/**
 * Which rows belong to each choice, keyed off `days_late` rather than a date
 * string. The server worked that number out against its own clock, so a phone
 * in a different timezone still sees the same "today" as the office does.
 *   days_late  1 = due yesterday · 0 = due today · -1 = due tomorrow
 */
const WHEN = [
  {
    value: 'yesterday',
    label: 'Yesterday',
    late: true,
    rows: (q) => q.missed.filter((r) => r.days_late === 1),
    sub: 'Promised for yesterday and still not made',
    empty: 'Nothing was due yesterday',
    hint: 'A call promised for yesterday and not yet made would sit here.',
  },
  {
    value: 'today',
    label: 'Today',
    rows: (q) => q.today,
    sub: 'Promised for today',
    empty: 'No calls due today',
    hint: 'Follow-ups scheduled for today appear here as they fall due.',
  },
  {
    value: 'tomorrow',
    label: 'Tomorrow',
    rows: (q) => q.upcoming.filter((r) => r.days_late === -1),
    sub: 'Booked for tomorrow — nothing here is late yet',
    empty: 'Nothing booked for tomorrow',
    hint: 'Calls promised for tomorrow appear here, so the day can be planned.',
  },
];
// Today is where the page opens. It used to be a combined "To call now" view;
// with that gone, the day someone is actually working is the sensible landing.
const DEFAULT_WHEN = 'today';
const whenOf = (v) => WHEN.find((w) => w.value === v)
  || WHEN.find((w) => w.value === DEFAULT_WHEN);

export default async function followUps({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const bodyHost = h('div', {});
  const tileHost = h('div', { class: 'tiles' });
  const filters = { when: whenOf(query.when).value };
  let q = null;

  // required, so the select has no blank "— none —" row: there is always a view.
  const form = buildForm([{
    name: 'when',
    label: 'Show',
    type: 'select',
    required: true,
    options: WHEN.map((w) => ({ value: w.value, label: w.label })),
  }], { when: filters.when });
  form.el.className = 'filters';
  form.el.addEventListener('change', () => {
    filters.when = whenOf(form.read().when).value;
    // the default view stays out of the URL
    setQuery({ when: filters.when === DEFAULT_WHEN ? '' : filters.when });
    render();
  });

  /**
   * One queue as a table. `late` spells out how far the call has slipped;
   * `noDate` is the queue of leads with no call booked at all, where there
   * is no due date to show and the point is that one is missing.
   */
  const queue = (rows, {
    late, noDate, empty, emptyHint,
  }) => dataTable({
    columns: [
      {
        key: 'name', label: 'Lead', render: (r) => h('div', {},
          h('div', { class: 'strong' }, r.name),
          h('div', { class: 'small muted' }, `${r.phone}${r.city ? ` · ${r.city}` : ''}`)),
      },
      { key: 'course_name', label: 'Interested in' },
      { key: 'priority', label: 'Priority', render: (r) => badge(r.priority) },
      { key: 'status', label: 'Status', render: (r) => badge(r.status) },
      {
        key: 'next_followup',
        label: late ? 'Was due' : 'Due',
        render: (r) => (noDate
          ? badge('Not scheduled', 'warn')
          : h('div', {},
            h('div', { class: 'small' }, fmt.date(r.next_followup)),
            late ? badge(`${r.days_late} day${r.days_late === 1 ? '' : 's'} late`, 'danger') : null)),
      },
      {
        key: 'last_touch', label: 'Last spoken', render: (r) => (r.last_touch
          ? h('span', { class: 'small' }, fmt.date(r.last_touch))
          : h('span', { class: 'muted small' }, 'Never')),
      },
      { key: 'assigned_name', label: 'Assigned to' },
      {
        key: 'call', label: 'Call', align: 'center',
        render: (r) => h('div', { class: 'row-actions' },
          // a real tel: link, so a desk phone or softphone can dial it
          h('a', { class: 'btn sm', href: `tel:${String(r.phone).replace(/\s+/g, '')}` }, '☎ Call'),
          h('button', {
            class: 'btn sm primary',
            // "Log call" read like system jargon. This says what the button
            // does in the words the office would use.
            title: 'Write down what happened on the call. The lead then drops off this list.',
            onClick: (e) => { e.stopPropagation(); logCall(r); },
          }, '✎ Add notes')),
      },
    ],
    rows,
    onRow: (r) => navigate(`/enquiries?id=${r.id}`),
    empty,
    emptyHint,
  });

  /**
   * Redraw the table for the current choice. No refetch — the data is held.
   * One day, one table. The three-card stack that the combined view used to
   * draw went with it.
   */
  function render() {
    const w = whenOf(filters.when);
    const rows = w.rows(q);
    clear(bodyHost).appendChild(
      card(`${w.label} — ${rows.length} call(s)`, queue(rows, {
        late: w.late,
        empty: w.empty,
        emptyHint: w.hint,
      }), { flush: true, sub: w.value === 'today' ? fmt.date(todayStr()) : w.sub }),
    );
  }

  async function load() {
    clear(bodyHost).appendChild(loading());
    // One day ahead, which is exactly as far as the Tomorrow view looks — so
    // switching between the days needs no further round trip. `total` counts
    // only what is owed now, so reaching forward cannot inflate the number on
    // the sidebar badge.
    const data = await api.get('/api/enquiries/followups/queue', { ahead: 1 });
    q = { unscheduled: [], upcoming: [], ...data };

    clear(tileHost).appendChild(h('div', { style: { display: 'contents' } },
      statTile({
        label: 'Missed calls',
        value: fmt.num(q.missed.length),
        tone: q.missed.length ? 'danger' : 'good',
        sub: q.missed.length ? 'Promised before today' : 'Nothing overdue',
      }),
      statTile({
        label: 'Due today',
        value: fmt.num(q.today.length),
        tone: q.today.length ? 'warn' : 'good',
        sub: fmt.date(todayStr()),
      }),
      statTile({
        label: 'Not scheduled',
        value: fmt.num(q.unscheduled.length),
        tone: q.unscheduled.length ? 'warn' : 'good',
        sub: q.unscheduled.length ? 'No call booked yet' : 'Every lead has a date',
      }),
      statTile({
        label: 'To call',
        value: fmt.num(q.total),
        // the same number the sidebar badge carries, from the same query
        sub: 'People waiting on a call',
      })));

    render();
  }

  /**
   * Logging the call is what clears the row: the follow-up is recorded against
   * the lead and the next date is set, which is the same thing the Enquiries
   * screen does — one code path, one behaviour.
   */
  function logCall(r) {
    formModal({
      title: `Add call notes — ${r.name}`,
      fields: [
        {
          type: 'node',
          span: true,
          node: h('div', { class: 'alert info' },
            h('span', { class: 'ico' }, '☎'),
            h('div', {}, h('b', {}, r.phone),
              r.course_name ? ` · asked about ${r.course_name}` : '',
              r.days_late > 0 ? ` · ${r.days_late} day(s) late` : '')),
        },
        { name: 'done_on', label: 'Called on', type: 'date', required: true },
        { name: 'channel', label: 'How', type: 'select', options: meta.enums.channels, required: true },
        { name: 'remark', label: 'What was said?', type: 'textarea', required: true, span: true, rows: 3 },
        { name: 'outcome', label: 'Outcome', placeholder: 'Interested / asked for a discount / no answer' },
        {
          name: 'status', label: 'Move status to', type: 'select', placeholder: 'Leave unchanged',
          options: meta.enums.enquiry_status.filter((s) => s !== 'Converted'),
        },
        {
          name: 'next_date', label: 'Call again on', type: 'date', span: true,
          hint: 'Leave blank if no further call is needed — the lead drops off this list either way.',
        },
      ],
      values: { done_on: todayStr(), channel: 'Call' },
      submitLabel: 'Save notes',
      async onSubmit(v, ctl) {
        await api.post(`/api/enquiries/${r.id}/followups`, v);
        ctl.close();
        toast(`Notes saved for ${r.name}`, 'good');
        await state.refreshMeta();     // the sidebar badge follows the queue
        load();
      },
    });
  }

  host.appendChild(pageHead('Follow-ups', 'Who to call today, and who was missed', [
    h('button', { class: 'btn', onClick: () => navigate('/enquiries') }, 'All enquiries →'),
  ]));
  host.appendChild(tileHost);
  host.appendChild(form.el);
  host.appendChild(bodyHost);
  await load();
  return host;
}
