'use strict';
/** Lead capture, follow-up log, and conversion into a student record. */

const { db } = require('../db');
const { requireWrite, canWrite, audit } = require('../auth');
const settings = require('../settings');
const { ensureCourse } = require('../courses');
const mailer = require('../mailer');
const C = require('../constants');
const {
  required, str, nowIso, today, toDate, notFound, badRequest, conflict,
  isEmail, isPhone, oneOf, toCsv, clamp,
} = require('../util');
const { raw } = require('../router');

/**
 * "A demo class still to be held." One definition, used by both the tile that
 * counts them and the filter that lists them, so the number on the tile and the
 * number of rows it opens cannot disagree.
 *
 * Today counts as still to come — a demo booked for this morning is work for
 * today, not history. A lead already converted or lost is dropped: whatever was
 * booked, that class is not happening now.
 */
const DEMO_DUE_WHERE = "e.demo_on IS NOT NULL AND date(e.demo_on) >= date('now')"
  + " AND e.status NOT IN ('Converted','Lost')";

/**
 * toDate() answers "today" for a blank input, which is wrong for every optional
 * date on an enquiry: an empty joining date means "has not joined", and an empty
 * next-call date means "no call scheduled" — not "call today". Left unguarded, a
 * cleared follow-up date silently re-booked the lead for today, so it never left
 * the Follow-ups queue.
 */
const dateOrNull = (v) => (str(v) ? toDate(v) : null);

/**
 * Which course a lead asked about, settled to exactly one of two columns.
 *
 * A course picked from the list wins outright and clears any write-in left
 * over from an earlier edit — otherwise a lead moved off "Other" onto a real
 * course would carry both, and the two would sooner or later disagree. With
 * nothing picked, whatever was typed stands on its own; blank means the lead
 * genuinely has not decided.
 */
function coursePick(body) {
  const id = body.course_id || null;
  return [id, id ? null : (str(body.course_other) || null)];
}

/** A tickbox arrives as 1, '1' or true depending on who is calling. */
const ticked = (v) => v === 1 || v === '1' || v === true;

/**
 * Settle the course side of an enquiry in one place: an id picked from the
 * list, a name typed in, or a name typed in and asked to be added — in which
 * case it stops being loose text at once and becomes a real course the enquiry
 * points at, so the next lead can simply pick it.
 */
function resolveCourse(user, body) {
  const [id, other] = coursePick(body);
  if (id || !other || !ticked(body.course_add)) return { id, other, added: null };
  /*
   * A counsellor may log leads all day but has no business editing the course
   * list. Refusing the whole enquiry over a tickbox would lose the lead in
   * order to protect the list, which is the wrong way round — the name stays
   * as a write-in and the response says plainly why it went no further.
   */
  if (!canWrite(user, 'courses')) {
    return { id: null, other, added: { name: other, blocked: `your role (${user.role}) cannot add courses` } };
  }
  const added = ensureCourse(user, other, {
    note: 'Added from an enquiry — fee and duration still to be filled in.',
  });
  return { id: added.id, other: null, added };
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Acknowledge a new enquiry by email, and optionally tell the office too.
 *
 * Never throws: the lead is already in the database by the time this runs, and
 * a mail server being down is not a reason to lose it. The outcome comes back
 * so the screen can say plainly what did and did not go out.
 */
async function notifyEnquiry(e, user) {
  const s = settings.all();
  const wantAck = s.enquiry_ack_enabled === '1';
  const wantInternal = s.enquiry_notify_internal === '1';
  if (!wantAck && !wantInternal) return { sent: false, reason: 'Enquiry emails are switched off' };
  if (!mailer.isConfigured()) {
    return { sent: false, reason: 'Email is not set up under Settings → Email' };
  }

  const about = e.course_name ? e.course_name : 'our courses';
  const contact = [s.phone, s.email].filter(Boolean).join(' · ');
  const results = [];

  if (wantAck && e.email) {
    const text = [
      `Dear ${e.name},`,
      '',
      `Thank you for enquiring about ${about}. We have your details and one of our`,
      'counsellors will be in touch shortly.',
      e.next_followup ? `We plan to call you on or before ${e.next_followup}.` : '',
      '',
      `If you need anything sooner, reach us on ${contact || 'the details below'}.`,
      '',
      s.institute_name,
    ].filter((l) => l !== '').join('\n');

    const html = `<div style="font:14px/1.6 Segoe UI,Arial,sans-serif;color:#1b1b1b">
  <p>Dear ${esc(e.name)},</p>
  <p>Thank you for enquiring about <b>${esc(about)}</b>. We have your details and one of our
     counsellors will be in touch shortly.</p>
  ${e.next_followup ? `<p>We plan to call you on or before <b>${esc(e.next_followup)}</b>.</p>` : ''}
  <p>If you need anything sooner, reach us on ${esc(contact)}.</p>
  <p style="margin-top:22px">${esc(s.institute_name)}<br>
     <span style="color:#6b7c8c">${esc(contact)}</span></p>
</div>`;

    try {
      await mailer.send({
        to: e.email,
        subject: `Thanks for your enquiry — ${s.institute_name}`,
        text,
        html,
      });
      results.push({ to: e.email, kind: 'acknowledgement', ok: true });
    } catch (err) {
      results.push({ to: e.email, kind: 'acknowledgement', ok: false, error: err.message });
    }
  }

  if (wantInternal && s.email) {
    const lines = [
      `${e.name} — ${e.phone}${e.email ? ` — ${e.email}` : ''}`,
      `Interested in: ${e.course_name || 'not decided'}`,
      `Source: ${e.source || '—'}   Priority: ${e.priority}`,
      `Assigned to: ${e.assigned_name || 'unassigned'}`,
      e.next_followup ? `Follow up by: ${e.next_followup}` : '',
      e.notes ? `Notes: ${e.notes}` : '',
      '',
      `Logged by ${user.name}.`,
    ].filter(Boolean);
    try {
      await mailer.send({
        to: s.email,
        subject: `New enquiry: ${e.name} — ${e.course_name || 'course not decided'}`,
        text: lines.join('\n'),
        html: `<div style="font:14px/1.6 Segoe UI,Arial,sans-serif">${
          lines.map((l) => esc(l)).join('<br>')}</div>`,
      });
      results.push({ to: s.email, kind: 'internal', ok: true });
    } catch (err) {
      results.push({ to: s.email, kind: 'internal', ok: false, error: err.message });
    }
  }

  if (!results.length) return { sent: false, reason: 'No address to send to' };
  const failed = results.filter((r) => !r.ok);
  return {
    sent: results.some((r) => r.ok),
    to: results.filter((r) => r.ok).map((r) => r.to),
    reason: failed.length ? failed[0].error : null,
  };
}

/**
 * The course this lead asked about, whichever way it was recorded: the name of
 * the course they picked, or — when they asked for something we do not run yet
 * — the name they were typed in under. One alias for both, so every screen,
 * export and email that already prints `course_name` keeps working without
 * having to know which of the two it is looking at.
 */
const COURSE_NAME_SQL = 'COALESCE(c.name, e.course_other)';

function detail(id) {
  const e = db.get(
    `SELECT e.*, ${COURSE_NAME_SQL} AS course_name, s.name AS assigned_name, st.reg_no AS student_reg_no,
            COALESCE(st.joined_on, e.joined_on) AS joined_on
       FROM enquiries e
       LEFT JOIN courses c ON c.id = e.course_id
       LEFT JOIN staff s ON s.id = e.assigned_to
       LEFT JOIN students st ON st.id = e.student_id
      WHERE e.id = ?`, [id],
  );
  if (!e) throw notFound('Enquiry not found');
  e.followups = db.all(
    'SELECT * FROM followups WHERE enquiry_id = ? ORDER BY done_on DESC, id DESC', [id],
  );
  return e;
}

module.exports = function register(router) {
  router.get('/api/enquiries', ({ query }) => {
    const where = [];
    const args = [];
    if (query.status) { where.push('e.status = ?'); args.push(query.status); }
    if (query.priority) { where.push('e.priority = ?'); args.push(query.priority); }
    if (query.source) { where.push('e.source = ?'); args.push(query.source); }
    if (query.course_id) { where.push('e.course_id = ?'); args.push(query.course_id); }
    if (query.assigned_to) { where.push('e.assigned_to = ?'); args.push(query.assigned_to); }
    /*
     * Date range. Whitelist the column — it is interpolated into SQL, so it can
     * never come straight from the query string. date() wraps both sides
     * because these can hold a full timestamp: without it a same-day "to"
     * would exclude that very day.
     */
    const DATE_FIELDS = {
      joined: 'COALESCE(st.joined_on, e.joined_on)',
      followup: 'e.next_followup',
      demo: 'e.demo_on',
    };
    const dateCol = DATE_FIELDS[query.date_field] || DATE_FIELDS.joined;
    if (query.from) { where.push(`date(${dateCol}) >= date(?)`); args.push(query.from); }
    if (query.to) { where.push(`date(${dateCol}) <= date(?)`); args.push(query.to); }
    if (query.from || query.to) where.push(`${dateCol} IS NOT NULL`);
    if (query.open === '1') where.push("e.status NOT IN ('Converted','Lost')");
    /*
     * The same definition the sidebar badge counts with, so filtering here
     * returns exactly the number the badge promised — including the leads with
     * no call booked at all, which the old wording ("next_followup IS NOT
     * NULL") quietly dropped.
     */
    if (query.due === '1') where.push(C.callsOwedWhere('e'));
    // Demos still to be held — the same definition the tile counts with.
    if (query.demo === '1') where.push(DEMO_DUE_WHERE);
    if (query.q) {
      where.push('(e.name LIKE ? OR e.phone LIKE ? OR e.email LIKE ? OR e.city LIKE ?)');
      const like = `%${query.q}%`;
      args.push(like, like, like, like);
    }
    const limit = clamp(query.limit || 200, 1, 1000);

    /*
     * joined_on: the student record owns the date once the lead converts, so
     * its value wins; before that the date typed on the enquiry stands. The
     * alias deliberately repeats a column already in e.* — it comes later in
     * the select list, so it is the one that lands in the row object.
     */
    const rows = db.all(
      `SELECT e.*, ${COURSE_NAME_SQL} AS course_name, s.name AS assigned_name, st.reg_no AS student_reg_no,
              COALESCE(st.joined_on, e.joined_on) AS joined_on,
              (SELECT COUNT(*) FROM followups f WHERE f.enquiry_id = e.id) AS followup_count,
              CASE WHEN e.next_followup IS NOT NULL
                    AND e.next_followup < date('now')
                    AND e.status NOT IN ('Converted','Lost') THEN 1 ELSE 0 END AS overdue
         FROM enquiries e
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN staff s ON s.id = e.assigned_to
         LEFT JOIN students st ON st.id = e.student_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY overdue DESC,
                 CASE e.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
                 COALESCE(e.next_followup, '9999') ASC, e.id DESC
        LIMIT ?`,
      [...args, limit],
    );

    /*
     * The tiles count the same set the table lists. They used to count the
     * whole register whatever the filter said, so narrowing to a July range
     * left eight rows sitting under tiles that still added up to thirty-four —
     * two numbers on one screen, disagreeing about the same thing.
     *
     * The students join comes along because a date filter can key off the
     * student's joining date, which lives on that table.
     */
    const scope = `FROM enquiries e LEFT JOIN students st ON st.id = e.student_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const counts = Object.fromEntries(
      db.all(`SELECT e.status AS status, COUNT(*) c ${scope} GROUP BY e.status`, args)
        .map((r) => [r.status, r.c]),
    );
    /*
     * A real count, not rows.length. The LIMIT above caps the list at 200, and
     * reporting the cap as the total would mean the heading quietly stopped
     * agreeing with the sidebar badge the moment the register passed 200.
     */
    const total = db.scalar(`SELECT COUNT(*) c ${scope}`, args);
    // counted over the same filtered set as the tiles beside it
    const demoDue = db.scalar(
      `SELECT COUNT(*) c ${scope}${where.length ? ' AND ' : ' WHERE '}${DEMO_DUE_WHERE}`, args,
    );
    return { rows, counts, total, demo_due: demoDue, shown: rows.length };
  });

  router.get('/api/enquiries/export', ({ query }) => {
    // the export honours the same date range, so what you download matches
    // what the screen is showing
    const where = [];
    const args = [];
    const DATE_FIELDS = {
      joined: 'COALESCE(st.joined_on, e.joined_on)',
      followup: 'e.next_followup',
      demo: 'e.demo_on',
    };
    const dateCol = DATE_FIELDS[query.date_field] || DATE_FIELDS.joined;
    if (query.from) { where.push(`date(${dateCol}) >= date(?)`); args.push(query.from); }
    if (query.to) { where.push(`date(${dateCol}) <= date(?)`); args.push(query.to); }
    if (query.from || query.to) where.push(`${dateCol} IS NOT NULL`);
    const rows = db.all(
      `SELECT e.name, e.phone, e.email, e.city, ${COURSE_NAME_SQL} AS course, e.source, e.status,
              e.priority, e.next_followup, e.demo_on,
              COALESCE(st.joined_on, e.joined_on) AS joined_on,
              st.reg_no AS reg_no, e.lost_reason, e.created_at
         FROM enquiries e
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN students st ON st.id = e.student_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.id DESC`,
      args,
    );
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `dhishaai-enquiries-${today()}.csv`);
  });

  /**
   * The call queue: who is waiting on a call, split by whether the promised
   * day has passed. Missed calls come first because they are the ones losing
   * the lead. Converted and lost enquiries are out of it entirely.
   *
   * A lead with no next_followup at all is on this list too. It used to be
   * filtered out, which meant an enquiry nobody got round to scheduling was
   * absent from the one screen whose job is to say who to ring — the quietest
   * way there is to lose a lead. `total` is what the sidebar badge shows, so
   * it counts exactly the rows this screen puts in front of someone.
   */
  router.get('/api/enquiries/followups/queue', ({ query }) => {
    const rows = db.all(
      `SELECT e.id, e.name, e.phone, e.email, e.city, e.status, e.priority, e.source,
              e.next_followup, e.notes,
              ${COURSE_NAME_SQL} AS course_name, s.name AS assigned_name,
              CAST(julianday(date('now')) - julianday(e.next_followup) AS INTEGER) AS days_late,
              (SELECT COUNT(*) FROM followups f WHERE f.enquiry_id = e.id) AS followup_count,
              (SELECT f.done_on FROM followups f WHERE f.enquiry_id = e.id
                ORDER BY f.done_on DESC, f.id DESC LIMIT 1) AS last_touch
         FROM enquiries e
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN staff s ON s.id = e.assigned_to
        WHERE e.status NOT IN ('Converted','Lost')
          AND (e.next_followup IS NULL OR date(e.next_followup) <= date('now', ?))
        ORDER BY e.next_followup IS NULL,
                 e.next_followup ASC,
                 CASE e.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END`,
      [`+${clamp(query.ahead || 0, 0, 60)} day`],
    );

    const today = [];
    const missed = [];
    const upcoming = [];
    const unscheduled = [];
    for (const r of rows) {
      if (r.next_followup == null) unscheduled.push(r);
      else if (r.days_late > 0) missed.push(r);
      else if (r.days_late === 0) today.push(r);
      else upcoming.push(r);
    }
    return {
      missed,
      today,
      unscheduled,
      upcoming,
      total: missed.length + today.length + unscheduled.length,
    };
  });

  router.get('/api/enquiries/:id', ({ params }) => detail(params.id));

  router.post('/api/enquiries', async ({ user, body }) => {
    requireWrite(user, 'enquiries');
    required(body, ['name', 'phone']);
    /*
     * Email is optional — a phone enquiry or a walk-in often has none, and
     * refusing the record over it loses the lead. What is typed still has to
     * look like an address, so a typo cannot be saved and then silently fail
     * to reach anyone.
     */
    if (str(body.email) && !isEmail(body.email)) {
      throw badRequest('Enter a valid email', { email: 'Invalid email address' });
    }
    if (!isPhone(body.phone)) throw badRequest('Enter a valid phone number', { phone: 'Invalid phone number' });
    /*
     * One transaction, because adding the course and recording the lead that
     * asked for it are the same act: a course left behind by an enquiry that
     * failed to save would be a course nobody asked for.
     */
    const { id, courseAdded } = db.tx(() => {
      const course = resolveCourse(user, body);
      const { lastInsertRowid } = db.run(
        `INSERT INTO enquiries (name, email, phone, city, course_id, course_other, source, assigned_to,
                                status, priority, next_followup, demo_on, joined_on, notes,
                                created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          str(body.name), str(body.email), str(body.phone), str(body.city),
          course.id, course.other, oneOf(body.source, C.SOURCES, 'Walk-in'),
          body.assigned_to || null, oneOf(body.status, C.ENQUIRY_STATUS, 'New'),
          oneOf(body.priority, C.PRIORITY, 'Medium'),
          dateOrNull(body.next_followup), dateOrNull(body.demo_on), dateOrNull(body.joined_on),
          str(body.notes), nowIso(), nowIso(),
        ],
      );
      return { id: Number(lastInsertRowid), courseAdded: course.added };
    });
    audit(user, 'create', 'enquiries', id, str(body.name));

    const out = detail(id);
    out.course_added = courseAdded;
    // The lead is already saved, so a mail failure must not undo it — the
    // outcome rides back on the response instead of throwing.
    out.notification = await notifyEnquiry(out, user);
    return out;
  });

  router.put('/api/enquiries/:id', ({ user, params, body }) => {
    requireWrite(user, 'enquiries');
    const e = db.get('SELECT * FROM enquiries WHERE id = ?', [params.id]);
    if (!e) throw notFound('Enquiry not found');
    // optional here too — see the POST above
    if (str(body.email) && !isEmail(body.email)) {
      throw badRequest('Enter a valid email', { email: 'Invalid email address' });
    }
    if (!isPhone(body.phone)) throw badRequest('Enter a valid phone number', { phone: 'Invalid phone number' });
    const status = oneOf(body.status, C.ENQUIRY_STATUS, e.status);
    if (status === 'Converted' && !e.student_id) {
      throw badRequest('Use the Convert action to turn this enquiry into a student.');
    }
    const joinedOn = dateOrNull(body.joined_on);
    // one transaction, for the reason given on the POST above
    const course = db.tx(() => {
      const picked = resolveCourse(user, body);
      db.run(
        `UPDATE enquiries SET name=?, email=?, phone=?, city=?, course_id=?, course_other=?, source=?, assigned_to=?,
                status=?, priority=?, next_followup=?, demo_on=?, joined_on=?, lost_reason=?, notes=?,
                updated_at=? WHERE id=?`,
        [
          str(body.name) || e.name, str(body.email), str(body.phone) || e.phone, str(body.city),
          picked.id, picked.other, oneOf(body.source, C.SOURCES, e.source), body.assigned_to || null,
          status, oneOf(body.priority, C.PRIORITY, e.priority),
          dateOrNull(body.next_followup), dateOrNull(body.demo_on), joinedOn,
          status === 'Lost' ? str(body.lost_reason) : null,
          str(body.notes), nowIso(), params.id,
        ],
      );
      /*
       * Once the lead is a student the student record owns the joining date, so
       * an edit here has to write through — otherwise the two would disagree and
       * the list (which prefers the student's date) would ignore what was typed.
       */
      if (e.student_id && joinedOn) {
        db.run('UPDATE students SET joined_on = ?, updated_at = ? WHERE id = ?',
          [joinedOn, nowIso(), e.student_id]);
      }
      return picked;
    });
    audit(user, 'update', 'enquiries', params.id, str(body.name) || e.name);
    const out = detail(params.id);
    out.course_added = course.added;
    return out;
  });

  router.del('/api/enquiries/:id', ({ user, params }) => {
    requireWrite(user, 'enquiries');
    const e = db.get('SELECT * FROM enquiries WHERE id = ?', [params.id]);
    if (!e) throw notFound('Enquiry not found');
    db.run('DELETE FROM enquiries WHERE id = ?', [params.id]);
    audit(user, 'delete', 'enquiries', params.id, e.name);
    return { ok: true };
  });

  // -------------------------------------------------------- follow-ups
  router.post('/api/enquiries/:id/followups', ({ user, params, body }) => {
    requireWrite(user, 'followups');
    const e = db.get('SELECT * FROM enquiries WHERE id = ?', [params.id]);
    if (!e) throw notFound('Enquiry not found');
    required(body, ['remark']);

    return db.tx(() => {
      db.run(
        `INSERT INTO followups (enquiry_id, done_on, channel, remark, outcome, next_date, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          params.id, toDate(body.done_on) || today(), oneOf(body.channel, C.CHANNELS, 'Call'),
          str(body.remark), str(body.outcome), dateOrNull(body.next_date),
          user.name, nowIso(),
        ],
      );
      // A logged follow-up advances the lead and reschedules the next touch.
      const nextStatus = body.status ? oneOf(body.status, C.ENQUIRY_STATUS, e.status)
        : (e.status === 'New' ? 'Contacted' : e.status);
      db.run(
        'UPDATE enquiries SET next_followup = ?, status = ?, updated_at = ? WHERE id = ?',
        [dateOrNull(body.next_date), nextStatus, nowIso(), params.id],
      );
      audit(user, 'create', 'followups', params.id, `${e.name}: ${str(body.remark).slice(0, 80)}`);
      return detail(params.id);
    });
  });

  router.del('/api/enquiries/:id/followups/:fid', ({ user, params }) => {
    requireWrite(user, 'followups');
    db.run('DELETE FROM followups WHERE id = ? AND enquiry_id = ?', [params.fid, params.id]);
    audit(user, 'delete', 'followups', params.fid, null);
    return detail(params.id);
  });

  // ----------------------------------------------------------- convert
  router.post('/api/enquiries/:id/convert', ({ user, params, body }) => {
    requireWrite(user, 'students');
    const e = db.get('SELECT * FROM enquiries WHERE id = ?', [params.id]);
    if (!e) throw notFound('Enquiry not found');
    if (e.student_id) {
      const s = db.get('SELECT reg_no FROM students WHERE id = ?', [e.student_id]);
      throw conflict(`Already converted to student ${s ? s.reg_no : e.student_id}`);
    }

    return db.tx(() => {
      const regNo = settings.nextRegNo();
      // the date already recorded on the enquiry is the default joining date
      const joinedOn = dateOrNull(body.joined_on) || e.joined_on || today();
      const { lastInsertRowid: sid } = db.run(
        `INSERT INTO students (reg_no, name, email, phone, city, qualification, college,
                               guardian_name, guardian_phone, source, status, stage,
                               joined_on, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'Active',?,?,?,?,?)`,
        [
          regNo, str(body.name) || e.name, str(body.email) || e.email,
          str(body.phone) || e.phone, str(body.city) || e.city,
          str(body.qualification), str(body.college),
          str(body.guardian_name), str(body.guardian_phone),
          e.source || 'Walk-in',
          // whatever the pipeline now starts at, rather than a name spelt here
          C.FIRST_STAGE, joinedOn,
          e.notes, nowIso(), nowIso(),
        ],
      );
      db.run(
        `INSERT INTO stage_history (student_id, from_stage, to_stage, note, changed_by, changed_at)
         VALUES (?,?,?,?,?,?)`,
        [sid, 'Enquiry', C.FIRST_STAGE, `Converted from enquiry #${params.id}`, user.name, nowIso()],
      );
      db.run(
        `UPDATE enquiries SET status = 'Converted', student_id = ?, next_followup = NULL,
                joined_on = ?, updated_at = ? WHERE id = ?`,
        [sid, joinedOn, nowIso(), params.id],
      );
      audit(user, 'update', 'enquiries', params.id, `converted → student ${regNo}`);
      return { student_id: sid, reg_no: regNo, enquiry: detail(params.id) };
    });
  });

  // ----------------------------------------------------- funnel report
  router.get('/api/enquiries/stats/funnel', () => {
    const byStatus = db.all('SELECT status, COUNT(*) c FROM enquiries GROUP BY status');
    const bySource = db.all(
      `SELECT COALESCE(source,'Unknown') AS source, COUNT(*) AS total,
              SUM(CASE WHEN status = 'Converted' THEN 1 ELSE 0 END) AS converted
         FROM enquiries GROUP BY source ORDER BY total DESC`,
    );
    for (const r of bySource) {
      r.conversion_rate = r.total ? Math.round((r.converted / r.total) * 100) : 0;
    }
    const total = db.scalar('SELECT COUNT(*) c FROM enquiries');
    const converted = db.scalar("SELECT COUNT(*) c FROM enquiries WHERE status = 'Converted'");
    return {
      by_status: byStatus,
      by_source: bySource,
      total,
      converted,
      conversion_rate: total ? Math.round((converted / total) * 100) : 0,
    };
  });
};
