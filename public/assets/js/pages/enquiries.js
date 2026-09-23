import { api } from '../api.js';
import {
  h, fmt, pageHead, dataTable, badge, formModal, toast, confirmDialog, buildForm,
  debounce, clear, loading, openModal, statTile, todayStr, addDaysStr,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';

/**
 * How a booked demo reads at a glance. Only the dates somebody has to act on
 * get a badge — a demo three weeks out needs no colour, and one already held
 * is marked so it cannot be mistaken for something still to come.
 */
function demoBadge(r) {
  if (!r.demo_on) return null;
  const day = String(r.demo_on).slice(0, 10);
  const today = todayStr();
  if (day === today) return badge('Today', 'warn');
  if (day < today) return badge('Done', '');
  return day === addDaysStr(today, 1) ? badge('Tomorrow', 'good') : null;
}

export default async function enquiries({ params, query, state }) {
  // reassigned after a course is added from the enquiry form, so the next form
  // this screen opens is built from the list that now includes it
  let meta = state.meta;
  const host = h('div', {});
  const tableHost = h('div', { class: 'card' });
  const tileHost = h('div', { class: 'tiles' });

  // No status/priority/source keys here on purpose. The controls for them are
  // gone, so reading them from the URL would apply a filter with nothing on
  // screen to explain it and no way to clear it.
  const filters = {
    q: query.q || '',
    course_id: query.course_id || '',
    open: query.open || '',
    due: query.due || '',
    demo: query.demo || '',
    from: query.from || '',
    to: query.to || '',
    date_field: query.date_field || 'joined',
  };

  // One name for this date everywhere it shows on the screen — the form, the
  // table, the detail panel and the range filter all read the same column.
  const DATE_FIELD_LABEL = { joined: 'Enquiry date', followup: 'Follow-up', demo: 'Demo class' };

  /**
   * Date filter over the joining date or the next touch. The button doubles as the indicator
   * — once a range is set it shows the range, so an active filter is never
   * hidden behind a dialog.
   */
  /** Names the range in words, so which date is being filtered is never a guess. */
  function dateSummary() {
    const { from, to, date_field: field } = filters;
    if (!from && !to) return null;
    const what = DATE_FIELD_LABEL[field] || 'Enquiry date';
    if (from && to) return `${what} ${fmt.dateShort(from)} → ${fmt.dateShort(to)}`;
    return from ? `${what} from ${fmt.dateShort(from)}` : `${what} up to ${fmt.dateShort(to)}`;
  }

  function paintDateBtn() {
    const summary = dateSummary();
    dateBtn.textContent = summary ? `▤ ${summary}` : '▤ Filter by date';
    dateBtn.classList.toggle('navy', !!summary);
  }

  function dateFilter() {
    const apply = (from, to, field) => {
      filters.from = from;
      filters.to = to;
      filters.date_field = field || 'joined';
      setQuery({ from, to, date_field: from || to ? filters.date_field : '' });
      paintDateBtn();
      load();
    };

    const ctl = formModal({
      title: 'Filter enquiries by date',
      size: 'narrow',
      fields: [
        {
          name: 'date_field',
          label: 'Which date',
          type: 'select',
          span: true,
          required: true,
          options: [
            { value: 'joined', label: 'Enquiry date — the date on the enquiry' },
            { value: 'followup', label: 'Next follow-up — the date in the table' },
            { value: 'demo', label: 'Demo class — the day the lead sits in' },
          ],
          hint: 'Both ends are included. Leave one blank for an open-ended range.',
        },
        { name: 'from', label: 'From (start date)', type: 'date', span: true },
        { name: 'to', label: 'To (end date)', type: 'date', span: true },
      ],
      values: { from: filters.from, to: filters.to, date_field: filters.date_field },
      submitLabel: 'Apply',
      extraFooter: h('button', {
        class: 'btn',
        onClick: () => { ctl.close(); apply('', '', 'joined'); toast('Date filter cleared', 'good'); },
      }, 'Clear'),
      async onSubmit(v, c, form) {
        if (!v.from && !v.to) {
          form.setErrors({ from: 'Give a start date, an end date, or both' });
          return;
        }
        if (v.from && v.to && v.from > v.to) {
          form.setErrors({ to: 'The end date is before the start date' });
          return;
        }
        c.close();
        apply(v.from || '', v.to || '', v.date_field);
      },
    });
  }

  async function load() {
    clear(tableHost).appendChild(loading());
    const data = await api.get('/api/enquiries', filters);
    const c = data.counts || {};

    /*
     * The server counts the demos due. A server still running the code from
     * before that field existed sends nothing, and `undefined || 0` would read
     * "None booked" while demo dates sat in the table directly below it — the
     * tile flatly contradicting the column. So fall back to counting the rows
     * that did arrive, using the same rule the server applies, and say plainly
     * when that count could only see part of the register.
     */
    const dueByRow = (r) => r.demo_on
      && String(r.demo_on).slice(0, 10) >= todayStr()
      && !['Converted', 'Lost'].includes(r.status);
    const serverCounted = data.demo_due != null;
    const demoDue = serverCounted ? data.demo_due : data.rows.filter(dueByRow).length;
    const partial = !serverCounted && data.rows.length < data.total;

    clear(tileHost).appendChild(h('div', { style: { display: 'contents' } },
      statTile({ label: 'New', value: fmt.num(c.New || 0), tone: 'accent' }),
      statTile({ label: 'Contacted', value: fmt.num(c.Contacted || 0) }),
      statTile({ label: 'Interested', value: fmt.num(c.Interested || 0), tone: 'good' }),
      statTile({ label: 'Negotiating', value: fmt.num(c.Negotiating || 0), tone: 'warn' }),
      statTile({ label: 'Converted', value: fmt.num(c.Converted || 0), tone: 'good' }),
      statTile({ label: 'Lost', value: fmt.num(c.Lost || 0), tone: 'danger' }),
      /*
       * Demo classes still to be held. Not a status like the six beside it —
       * a lead sits in one status but may also have a demo booked — so it
       * counts across all of them rather than adding up with them.
       *
       * Clicking it narrows the list to exactly those leads, and clicking it
       * again clears the filter, so the tile is both the number and the way in.
       */
      statTile({
        label: 'Demo to conduct',
        value: fmt.num(demoDue),
        tone: demoDue ? 'accent' : '',
        sub: filters.demo === '1'
          ? 'Showing these — click to clear'
          : (partial
            ? `At least this many, of the ${fmt.num(data.rows.length)} shown`
            : (demoDue ? 'Booked, not yet held' : 'None booked')),
        onClick: () => {
          filters.demo = filters.demo === '1' ? '' : '1';
          setQuery(filters);
          load();
        },
      })));

    clear(tableHost).appendChild(h('div', {},
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, `${fmt.num(data.total)} enquir${data.total === 1 ? 'y' : 'ies'}`),
          h('div', { class: 'sub' },
            [
              // say so when the list is capped, rather than letting the
              // heading and the number of rows on screen quietly disagree
              data.rows.length < data.total ? `Showing the first ${fmt.num(data.rows.length)}` : null,
              dateSummary(),
              'overdue follow-ups first',
            ].filter(Boolean).join(' · ')))),
      dataTable({
        columns: [
          {
            key: 'name', label: 'Lead', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.name),
              h('div', { class: 'small muted' }, `${r.phone}${r.city ? ` · ${r.city}` : ''}`)),
          },
          { key: 'course_name', label: 'Interested in' },
          { key: 'source', label: 'Source', render: (r) => badge(r.source, 'navy') },
          { key: 'priority', label: 'Priority', render: (r) => badge(r.priority) },
          { key: 'status', label: 'Status', render: (r) => badge(r.status) },
          {
            // Only a converted lead has a joining date — it comes from the
            // student record created at conversion, not from the enquiry.
            key: 'joined_on', label: 'Enquiry date', render: (r) => (r.joined_on
              ? h('div', {},
                h('div', { class: 'small' }, fmt.date(r.joined_on)),
                r.student_reg_no ? h('div', { class: 'small muted' }, r.student_reg_no) : null)
              : h('span', { class: 'muted' }, '—')),
          },
          {
            key: 'next_followup', label: 'Next follow-up', render: (r) => (r.next_followup
              ? h('div', {},
                h('div', { class: 'small' }, fmt.date(r.next_followup)),
                r.overdue ? badge('Overdue', 'danger') : null)
              : h('span', { class: 'muted' }, '—')),
          },
          {
            /*
             * The demo class booked for this lead. Today and tomorrow are
             * called out because those are the ones somebody has to prepare
             * for; a date already past is marked so it is not mistaken for
             * something still coming.
             */
            key: 'demo_on', label: 'Demo class', render: (r) => (r.demo_on
              ? h('div', {},
                h('div', { class: 'small' }, fmt.date(r.demo_on)),
                demoBadge(r))
              : h('span', { class: 'muted' }, '—')),
          },
          { key: 'followup_count', label: 'Touches', align: 'right', render: (r) => h('span', { class: 'mono' }, r.followup_count) },
          {
            key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm', onClick: () => openEnquiry(r.id) }, 'Open')),
          },
        ],
        rows: data.rows,
        onRow: (r) => openEnquiry(r.id),
        empty: 'No enquiries match these filters',
        emptyHint: 'Every walk-in and phone call logged here becomes a trackable lead.',
      }),
      h('div', { class: 'export-bar' },
        h('button', {
          class: 'btn sm',
          onClick: () => api.download('/api/enquiries/export', {
            from: filters.from, to: filters.to, date_field: filters.date_field,
          }),
        }, '↓ Export CSV'))));
  }

  // -------------------------------------------------------- detail
  async function openEnquiry(id) {
    const e = await api.get(`/api/enquiries/${id}`);
    const body = h('div', {});

    const draw = () => {
      clear(body).appendChild(h('div', {},
        h('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '14px' } },
          badge(e.status), badge(e.priority),
          e.source ? badge(e.source, 'navy') : null,
          e.student_reg_no ? badge(`Student ${e.student_reg_no}`, 'good') : null),

        h('dl', { class: 'kv', style: { marginBottom: '18px' } },
          h('dt', {}, 'Phone'), h('dd', {}, e.phone),
          h('dt', {}, 'Email'), h('dd', {}, e.email || '—'),
          h('dt', {}, 'City'), h('dd', {}, e.city || '—'),
          h('dt', {}, 'Course'),
          // A write-in reads exactly like a real course here, so it says which
          // it is — nobody should go looking for a batch that cannot exist.
          h('dd', {}, e.course_name
            ? h('span', {}, e.course_name, e.course_id
              ? null
              : h('span', { class: 'small muted' }, ' · not one we run yet'))
            : '—'),
          h('dt', {}, 'Assigned to'), h('dd', {}, e.assigned_name || '—'),
          h('dt', {}, 'Next follow-up'), h('dd', {}, e.next_followup ? fmt.date(e.next_followup) : '—'),
          h('dt', {}, 'Demo class'),
          h('dd', {}, e.demo_on
            ? h('span', {}, fmt.date(e.demo_on), ' ', demoBadge(e))
            : 'Not booked'),
          e.joined_on ? h('dt', {}, 'Enquiry date') : null,
          e.joined_on ? h('dd', {}, fmt.date(e.joined_on)) : null,
          e.lost_reason ? h('dt', {}, 'Lost because') : null,
          e.lost_reason ? h('dd', {}, e.lost_reason) : null,
          h('dt', {}, 'Notes'), h('dd', {}, e.notes || '—')),

        h('h4', { style: { margin: '0 0 10px', fontSize: '13px' } }, `Follow-up log (${e.followups.length})`),
        e.followups.length
          ? h('div', { class: 'timeline' }, e.followups.map((f) => h('div', { class: 'item' },
            h('div', {}, h('b', {}, f.channel || 'Note'), ' — ', f.remark),
            f.outcome ? h('div', { class: 'small muted' }, `Outcome: ${f.outcome}`) : null,
            h('div', { class: 'when' },
              `${fmt.date(f.done_on)} by ${f.created_by || 'system'}`,
              f.next_date ? ` · next ${fmt.date(f.next_date)}` : ''))))
          : h('div', { class: 'muted small' }, 'No follow-ups logged yet.')));
    };
    draw();

    /** Reopen this card — what "cancel" should land on, not the bare list. */
    const back = () => openEnquiry(id);

    const ctl = openModal({
      title: e.name,
      size: 'wide',
      body,
      footer: [
        h('button', { class: 'btn danger', onClick: () => remove(e, ctl) }, 'Delete'),
        h('div', { style: { flex: '1' } }),
        // these replace the detail card, so backing out of one returns to it
        h('button', { class: 'btn', onClick: () => { ctl.close(); enquiryModal(e, back); } }, '✎ Edit'),
        h('button', { class: 'btn', onClick: () => { ctl.close(); followupModal(e, back); } }, '☎ Log follow-up'),
        e.student_id
          ? h('button', { class: 'btn navy', onClick: () => { ctl.close(); navigate(`/students/${e.student_id}`); } }, 'Open student →')
          : h('button', { class: 'btn primary', onClick: () => { ctl.close(); convert(e, back); } }, '→ Convert to student'),
      ],
      onClose: () => { if (params.id) setQuery({}); },
    });
  }

  function enquiryModal(e, onDismiss) {
    let saved = false;
    formModal({
      onClose: () => { if (!saved && onDismiss) onDismiss(); },
      title: e ? `Edit ${e.name}` : 'New enquiry',
      size: 'wide',
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'phone', label: 'Phone', type: 'tel', required: true },
        {
          // Not required. A phone enquiry or a walk-in often has no email at
          // all, and refusing to save the lead over it loses the lead.
          name: 'email',
          label: 'Email',
          type: 'email',
          hint: 'Needed only if you want the acknowledgement email to reach them.',
        },
        { name: 'city', label: 'City' },
        {
          name: 'course_id', label: 'Interested in', type: 'select', placeholder: 'Not decided',
          options: meta.lookups.courses.map((c) => ({ value: c.id, label: c.name })),
          /*
           * People ask for things that are not on the list — a subject we are
           * only thinking about running, or a name they picked up elsewhere.
           * The list alone left "Not decided" as the only honest answer, which
           * throws away the one detail the follow-up call needs. Typed in here
           * it is kept, and it shows wherever a course name shows.
           */
          other: {
            name: 'course_other',
            label: 'Other — not in this list',
            fieldLabel: 'Which course did they ask for?',
            placeholder: 'e.g. Advanced Excel',
            hint: 'Only for something we do not offer yet. If we do run it, pick it above instead.',
            error: 'Type what they asked for, or pick one from the list',
            /*
             * The same typing, twice over, is how a course ends up on the list
             * three times spelt three ways. Ticking this puts it on the list
             * once, here, with a code worked out for it — then the next lead
             * who asks simply picks it. Fee and duration are filled in later
             * under Courses; nobody has them mid-enquiry, and demanding them
             * here is what would send the answer back to loose text.
             */
            also: {
              name: 'course_add',
              label: 'Add this to the course list',
              hint: 'It becomes a course you can pick next time. Set its fee and duration later under Courses.',
            },
          },
        },
        { name: 'source', label: 'Source', type: 'select', options: meta.enums.sources, required: true },
        {
          name: 'assigned_to', label: 'Assigned to', type: 'select', placeholder: 'Unassigned',
          options: meta.lookups.staff.map((s) => ({ value: s.id, label: s.name })),
        },
        { name: 'priority', label: 'Priority', type: 'select', options: meta.enums.priority, required: true },
        { name: 'status', label: 'Status', type: 'select', options: meta.enums.enquiry_status.filter((s) => s !== 'Converted'), required: true },
        // Enquiry date first: it is the date the lead exists from, so it reads
        // ahead of the date of the next call rather than after it.
        {
          name: 'joined_on', label: 'Enquiry date', type: 'date',
          // The column behind this is still joined_on, and converting a lead
          // copies it onto the student record — so whatever goes here is what
          // the student's joining date becomes. Worth saying out loud rather
          // than letting it be discovered from the Students screen later.
          hint: 'Also becomes the joining date if this lead converts.',
        },
        { name: 'next_followup', label: 'Next follow-up', type: 'date' },
        {
          name: 'demo_on', label: 'Demo class on', type: 'date',
          hint: 'The day this lead sits in on a class. Leave blank if none is booked.',
        },
        { name: 'lost_reason', label: 'Reason (if lost)' },
        { name: 'notes', label: 'Notes', type: 'textarea', span: true, rows: 3 },
      ],
      values: e || { status: 'New', priority: 'Medium', source: 'Walk-in', next_followup: todayStr() },
      submitLabel: e ? 'Save changes' : 'Add enquiry',
      async onSubmit(v, ctl) {
        let created = null;
        let out;
        if (e) out = await api.put(`/api/enquiries/${e.id}`, v);
        else { created = await api.post('/api/enquiries', v); out = created; }
        saved = true;
        ctl.close();
        /*
         * The lead is saved either way; the acknowledgement is a separate
         * thing that can fail on its own, so it is reported on its own rather
         * than left to be discovered later.
         */
        const n = created && created.notification;
        if (n && n.sent) toast(`Enquiry added · emailed ${n.to.join(', ')}`, 'good');
        else if (n && n.reason && n.reason !== 'Enquiry emails are switched off') {
          toast(`Enquiry added, but no email went out — ${n.reason}`, 'warn', 7000);
        } else toast(e ? 'Enquiry updated' : 'Enquiry added', 'good');

        /*
         * A new course is a change to the whole app, not just to this lead, so
         * it is said out loud and the shared lookups are refreshed — otherwise
         * the very next enquiry form would still be showing the old list and
         * the course would look as though it had not been added at all.
         */
        const added = out && out.course_added;
        if (added && added.blocked) {
          // the lead is saved and the course name kept — only the list was
          // left alone, and it says which
          toast(`Kept "${added.name}" on this lead, but not added to the course list — ${added.blocked}`, 'warn', 8000);
        } else if (added) {
          toast(added.existing
            ? `${added.name} is already on your course list (${added.code}) — linked to it`
            : `${added.name} added to your course list as ${added.code} · set its fee under Courses`,
          'good', 7000);
          meta = await state.refreshMeta();
        }
        load();
      },
    });
  }

  function followupModal(e, onDismiss) {
    let saved = false;
    formModal({
      onClose: () => { if (!saved && onDismiss) onDismiss(); },
      title: `Log a follow-up — ${e.name}`,
      fields: [
        { name: 'done_on', label: 'Date', type: 'date', required: true },
        { name: 'channel', label: 'Channel', type: 'select', options: meta.enums.channels, required: true },
        { name: 'remark', label: 'What was discussed?', type: 'textarea', required: true, span: true, rows: 3 },
        { name: 'outcome', label: 'Outcome', placeholder: 'Interested / asked for a discount / will confirm' },
        {
          name: 'status', label: 'Move status to', type: 'select', placeholder: 'Leave unchanged',
          options: meta.enums.enquiry_status.filter((s) => s !== 'Converted'),
        },
        { name: 'next_date', label: 'Next follow-up on', type: 'date', span: true },
      ],
      values: { done_on: todayStr(), channel: 'Call' },
      submitLabel: 'Save follow-up',
      async onSubmit(v, ctl) {
        await api.post(`/api/enquiries/${e.id}/followups`, v);
        saved = true;
        ctl.close();
        toast('Follow-up logged', 'good');
        load();
      },
    });
  }

  function convert(e, onDismiss) {
    let saved = false;
    formModal({
      onClose: () => { if (!saved && onDismiss) onDismiss(); },
      title: `Convert ${e.name} into a student`,
      size: 'wide',
      fields: [
        { type: 'node', span: true, node: h('div', { class: 'alert info' },
          h('div', {}, h('b', {}, 'A registration number is generated automatically.'),
            ' The enquiry is marked Converted and linked to the new student record.')) },
        { name: 'name', label: 'Name', required: true },
        { name: 'phone', label: 'Phone', type: 'tel', required: true },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'city', label: 'City' },
        { name: 'qualification', label: 'Qualification' },
        { name: 'college', label: 'College' },
        { name: 'guardian_name', label: 'Guardian name' },
        { name: 'guardian_phone', label: 'Guardian phone', type: 'tel' },
        { name: 'joined_on', label: 'Joining date', type: 'date', required: true, span: true },
      ],
      values: {
        name: e.name, phone: e.phone, email: e.email, city: e.city,
        joined_on: e.joined_on || todayStr(),
      },
      submitLabel: 'Convert to student',
      async onSubmit(v, ctl) {
        const out = await api.post(`/api/enquiries/${e.id}/convert`, v);
        saved = true;
        ctl.close();
        toast(`${v.name} registered as ${out.reg_no}`, 'good');
        navigate(`/students/${out.student_id}`);
      },
    });
  }

  async function remove(e, ctl) {
    const go = await confirmDialog({
      title: 'Delete enquiry',
      message: `Delete ${e.name} and their ${e.followups.length} follow-up note(s)? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!go) return;
    await api.del(`/api/enquiries/${e.id}`);
    ctl.close();
    toast('Enquiry deleted', 'good');
    load();
  }

  // ---------------------------------------------------------- chrome
  const form = buildForm([
    { name: 'q', label: 'Search', placeholder: 'Name, phone, email' },
    {
      name: 'course_id', label: 'Course', type: 'select', placeholder: 'All courses',
      options: meta.lookups.courses.map((c) => ({ value: c.id, label: c.name })),
    },
    { name: 'open', label: 'Only open leads', type: 'checkbox' },
    { name: 'due', label: 'Only waiting on a call', type: 'checkbox' },
  ], { ...filters, open: filters.open === '1', due: filters.due === '1' });

  const apply = () => {
    const v = form.read();
    Object.assign(filters, { ...v, open: v.open ? '1' : '', due: v.due ? '1' : '' });
    // setQuery merges into whatever is already in the hash, so blank these out
    // explicitly — otherwise an old bookmarked ?status=… would sit in the
    // address bar forever, looking like a filter that is no longer applied.
    setQuery({ ...filters, status: '', priority: '', source: '' });
    load();
  };
  form.el.addEventListener('change', apply);
  form.el.querySelector('input').addEventListener('input', debounce(apply, 320));
  form.el.className = 'filters';

  const dateBtn = h('button', { class: 'btn', onClick: () => dateFilter() });
  paintDateBtn();

  host.appendChild(pageHead('Enquiries', 'Every lead, from the first call to admission', [
    dateBtn,
    h('button', { class: 'btn', onClick: () => showFunnel() }, '◫ Conversion funnel'),
    h('button', { class: 'btn primary', onClick: () => enquiryModal() }, '+ New enquiry'),
  ]));
  host.appendChild(tileHost);
  host.appendChild(form.el);
  host.appendChild(tableHost);

  async function showFunnel() {
    const f = await api.get('/api/enquiries/stats/funnel');
    openModal({
      title: 'Conversion funnel',
      size: 'wide',
      body: h('div', {},
        h('div', { class: 'alert info', style: { marginBottom: '14px' } },
          h('div', {}, h('b', {}, `${f.conversion_rate}% overall conversion`),
            ` — ${f.converted} of ${f.total} enquiries became students.`)),
        dataTable({
          columns: [
            { key: 'source', label: 'Source' },
            { key: 'total', label: 'Enquiries', align: 'right' },
            { key: 'converted', label: 'Converted', align: 'right' },
            {
              key: 'conversion_rate', label: 'Rate', align: 'right',
              render: (r) => badge(`${r.conversion_rate}%`, r.conversion_rate >= 30 ? 'good' : r.conversion_rate >= 15 ? 'warn' : 'danger'),
            },
          ],
          rows: f.by_source,
          empty: 'No enquiries recorded yet',
        })),
      footer: [],
    });
  }

  await load();
  if (params.id) openEnquiry(params.id);
  return host;
}
