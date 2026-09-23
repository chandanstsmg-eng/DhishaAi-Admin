import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, buildForm, clear, loading,
  statTile, toast, progressBar, todayStr, batchText,
} from '../ui.js';
import { navigate, setQuery } from '../router.js';

/*
 * The classes that count for a student: present + absent, and nothing else.
 *
 * Worked out here rather than read straight off the row because a server still
 * running older code sends neither `held` nor `counted`, and printing them raw
 * put "of undefined" under every percentage. Falling back through what did
 * arrive keeps the table right on any version.
 */
const heldOf = (r) => {
  if (r.held != null) return r.held;
  if (r.counted != null) return r.counted;
  return (Number(r.present) || 0) + (Number(r.absent) || 0);
};

export default async function attendance({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const sheetHost = h('div', {});

  const batches = meta.lookups.batches;
  const selection = {
    batch_id: query.batch_id || (batches[0] ? String(batches[0].id) : ''),
    date: query.date || todayStr(),
  };

  const picker = buildForm([
    {
      name: 'batch_id', label: 'Batch', type: 'select', required: true, placeholder: 'Choose a batch',
      // the start date follows the code, so same-code-different-term is clear
      options: batches.map((b) => ({
        value: b.id,
        label: `${b.code} · starts ${fmt.batch(b.start_date) || '—'} · ${b.status} · ${b.filled} student(s)`,
      })),
    },
    { name: 'date', label: 'Session date', type: 'date', required: true, max: todayStr() },
  ], selection);
  picker.el.className = 'filters';
  picker.el.addEventListener('change', () => {
    Object.assign(selection, picker.read());
    setQuery(selection);
    load();
  });

  async function load() {
    if (!selection.batch_id) {
      clear(sheetHost).appendChild(card(null, h('div', { class: 'dt-empty' },
        h('div', { class: 'big' }, '◍'),
        h('div', {}, 'No batches available'),
        h('button', { class: 'btn primary', style: { marginTop: '12px' }, onClick: () => navigate('/batches') },
          'Create a batch'))));
      return;
    }

    clear(sheetHost).appendChild(loading());
    const [sheet, summary] = await Promise.all([
      api.get('/api/attendance/sheet', selection),
      api.get('/api/attendance/summary', { batch_id: selection.batch_id }),
    ]);

    const marks = new Map(sheet.roster.map((r) => [r.student_id, r.status || 'Present']));
    const remarks = new Map(sheet.roster.map((r) => [r.student_id, r.remark || '']));

    const setAll = (status) => {
      for (const r of sheet.roster) marks.set(r.student_id, status);
      draw();
    };

    const save = async () => {
      const records = sheet.roster.map((r) => ({
        student_id: r.student_id,
        status: marks.get(r.student_id),
        remark: remarks.get(r.student_id),
      }));
      try {
        const out = await api.post('/api/attendance/sheet', {
          batch_id: selection.batch_id, session_date: selection.date, records,
        });
        toast(`Attendance saved for ${out.saved} student(s)`, 'good');
        load();
      } catch (err) { toast(err.message, 'danger', 6000); }
    };

    const draw = () => {
      // 'Late' is no longer offered but old sheets still carry it, and it has
      // always meant the student turned up. A cancelled session is counted
      // apart — it is nobody's absence.
      const present = sheet.roster.filter((r) => ['Present', 'Late'].includes(marks.get(r.student_id))).length;
      const cancelled = sheet.roster.filter((r) => marks.get(r.student_id) === 'No class').length;
      const absent = sheet.roster.length - present - cancelled;

      /*
       * The whole day cancelled, said plainly at the top of the sheet. This is
       * what replaced the per-student "No class" column: the fact belongs to
       * the day, not to each student, and saying it once here means it can be
       * left out of everyone's totals without the screen going quiet about it.
       */
      const wholeDayOff = sheet.roster.length > 0 && cancelled === sheet.roster.length;
      const dayNote = wholeDayOff
        ? h('div', {
          class: 'alert info',
          style: { margin: '0 0 12px' },
        }, h('b', {}, 'No class on this date.'),
        ' Nothing here counts towards anyone\'s attendance — not as present, not as absent.')
        : null;

      const sheetCard = card(
        `${batchText(sheet.batch.start_date, sheet.batch.code)} — ${fmt.date(sheet.date)}`, [dayNote, dataTable({
        columns: [
          {
            key: 'name', label: 'Student', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.name),
              h('div', { class: 'small muted' }, r.reg_no)),
          },
          {
            key: 'status', label: 'Attendance', render: (r) => h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
              meta.enums.attendance_status.map((st) => h('button', {
                type: 'button',
                class: `btn sm ${marks.get(r.student_id) === st ? (st === 'Absent' ? 'danger' : 'primary') : ''}`,
                onClick: () => { marks.set(r.student_id, st); draw(); },
              }, st))),
          },
          {
            key: 'remark', label: 'Remark', render: (r) => h('input', {
              class: 'input', value: remarks.get(r.student_id), placeholder: 'Optional',
              onInput: (e) => remarks.set(r.student_id, e.target.value),
            }),
          },
        ],
        rows: sheet.roster,
        empty: 'No active students in this batch',
        emptyHint: 'Enroll students into this batch before marking attendance.',
      })], {
        flush: true,
        sub: `${sheet.batch.course_name}${sheet.batch.trainer_name ? ` · ${sheet.batch.trainer_name}` : ''}`,
        right: h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { class: 'btn sm', onClick: () => setAll('Present') }, 'All present'),
          h('button', { class: 'btn sm', onClick: () => setAll('Absent') }, 'All absent'),
          h('button', { class: 'btn sm primary', onClick: save }, '✓ Save attendance')),
      });

      const summaryCard = card('Attendance so far', [dataTable({
        columns: [
          {
            key: 'name',
            label: 'Student',
            render: (r) => h('div', { style: { whiteSpace: 'nowrap' } },
              h('div', {}, r.name),
              h('div', { class: 'small muted' }, r.reg_no)),
          },
          {
            /*
             * Classes held for this student, not marks recorded. It used to
             * count every row in the table including the cancelled ones, so a
             * line could read "4 marked, 2 present, 1 absent" and leave the
             * reader hunting for the fourth. This is exactly the two columns
             * beside it added together.
             */
            key: 'held', label: 'Classes held', align: 'right',
            render: (r) => h('span', { class: 'mono' }, fmt.num(heldOf(r))),
          },
          { key: 'present', label: 'Present', align: 'right' },
          { key: 'absent', label: 'Absent', align: 'right' },
          {
            // present ÷ classes held. The denominator is spelled out because it
            // is deliberately not the number of sessions the batch has run.
            key: 'percent', label: 'Rate', align: 'right', render: (r) => {
              const held = heldOf(r);
              // nothing this student was due at has actually run yet — 0% would
              // read as a record of never turning up
              if (!held) return h('span', { class: 'small muted' }, 'No classes yet');
              const pct = Math.round((r.present / held) * 100);
              return h('div', {},
                h('div', { class: 'small mono' }, `${pct}%`),
                h('div', { class: 'small muted' }, `of ${held}`),
                progressBar(pct));
            },
          },
        ],
        rows: summary.rows,
        onRow: (r) => navigate(`/students/${r.student_id}`),
        empty: 'Nothing marked yet',
      }),
      h('div', { class: 'export-bar' },
        h('button', {
          class: 'btn sm',
          onClick: () => api.download('/api/attendance/export', { batch_id: selection.batch_id }),
        }, '↓ Export CSV')),
      ], {
        flush: true,
        /*
         * What the column used to say, said once for the batch instead of on
         * every row. These are the sessions the numbers above deliberately do
         * not include, and without a word about them the session count and the
         * per-student totals simply look like they disagree.
         */
        sub: [
          `${summary.sessions_held} session(s) recorded for this batch`,
          summary.cancelled_sessions
            ? `${summary.cancelled_sessions} cancelled (marked "No class")`
            : null,
          summary.excused ? `${summary.excused} excused` : null,
          (summary.cancelled_sessions || summary.excused)
            ? 'neither counts towards the rate' : null,
        ].filter(Boolean).join(' · '),
      });

      clear(sheetHost).appendChild(h('div', {},
        // No roster-count tile. The sheet below is the roster, and counting
        // its own rows back at you says nothing you cannot already see.
        h('div', { class: 'tiles' },
          statTile({ label: 'Marked present today', value: fmt.num(present), tone: 'good' }),
          statTile({
            label: 'Marked absent',
            value: fmt.num(absent),
            tone: absent > 0 ? 'warn' : '',
            sub: cancelled ? `${fmt.num(cancelled)} marked "No class"` : null,
          }),
          statTile({
            label: 'Already saved',
            value: sheet.marked ? `${sheet.marked} student(s)` : 'Not yet',
            tone: sheet.marked ? 'good' : '',
            sub: sheet.marked ? 'Saving again overwrites it' : 'Mark and save below',
          })),
        /*
         * One under the other rather than side by side. The sheet is the
         * working surface — four buttons and a remark box per student — and
         * squeezing it into two thirds left the buttons cramped. The summary
         * carries six columns and never fitted the remaining third either; it
         * scrolled sideways inside its own card, which is how "Student" ended
         * up half cut off. Full width each and neither has to give anything up.
         */
        h('div', { class: 'grid' }, sheetCard, summaryCard)));
    };

    draw();
  }

  host.appendChild(pageHead('Attendance', 'Mark a session, then review the running percentage per student', [
    h('button', { class: 'btn', onClick: () => navigate('/batches') }, 'Batches'),
  ]));
  host.appendChild(picker.el);
  host.appendChild(sheetHost);

  await load();
  return host;
}
