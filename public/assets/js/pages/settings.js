import { api } from '../api.js';
import {
  h, fmt, card, pageHead, dataTable, badge, formModal, toast, confirmDialog,
  buildForm, clear, loading, tabs, statTile, openModal,
} from '../ui.js';
import { setQuery } from '../router.js';

export default async function settingsPage({ query, state }) {
  const meta = state.meta;
  const host = h('div', {});
  const bodyHost = h('div', {});
  let tab = query.tab || 'institute';

  const isAdmin = ['owner', 'admin'].includes(state.user.role);
  const isOwner = state.user.role === 'owner';

  const TABS = [
    { key: 'institute', label: 'Institute' },
    ...(isAdmin ? [
      { key: 'users', label: 'Users' },
      { key: 'announce', label: 'Announcements' },
      { key: 'audit', label: 'Audit log' },
      { key: 'import', label: 'Import' },
      { key: 'data', label: 'Data & backup' },
    ] : []),
    { key: 'about', label: 'About' },
  ];

  function drawTabs() {
    return tabs(TABS, tab, (k) => {
      tab = k;
      setQuery({ tab: k });
      host.querySelector('.tabs').replaceWith(drawTabs());
      load();
    });
  }

  async function load() {
    clear(bodyHost).appendChild(loading());
    const view = {
      institute, users, announce, audit, import: importSheet, data, about,
    }[tab];
    try {
      clear(bodyHost).appendChild(await view());
    } catch (err) {
      clear(bodyHost).appendChild(card(null, h('div', { class: 'dt-empty' }, err.message)));
    }
  }

  // ---------------------------------------------------- institute
  async function institute() {
    const s = await api.get('/api/settings');
    const form = buildForm([
      { type: 'section', label: 'Identity' },
      { name: 'institute_name', label: 'Institute name', required: true },
      { name: 'tagline', label: 'Tagline' },
      { name: 'phone', label: 'Phone' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'website', label: 'Website' },
      { name: 'gstin', label: 'GSTIN' },
      { name: 'address', label: 'Address', type: 'textarea', span: true, rows: 2 },
      { name: 'city', label: 'City' },
      { name: 'academic_year', label: 'Academic year' },

      { type: 'section', label: 'Numbering' },
      { name: 'reg_prefix', label: 'Registration prefix', hint: 'Numbers look like DA-2026-0001.' },
      { name: 'receipt_prefix', label: 'Receipt prefix', hint: 'Receipts look like RCPT-2026-000001.' },
      { name: 'currency', label: 'Currency symbol' },
      { name: 'currency_code', label: 'Currency code' },

      { type: 'section', label: 'Behaviour' },
      {
        name: 'default_tax_percent', label: 'GST %', type: 'number', step: '0.01',
        hint: 'Applied to new courses, fee plans and enrollments that do not set their own rate.',
      },
      { name: 'fee_due_reminder_days', label: 'Show fees due within (days)', type: 'number', min: '0' },
      { name: 'terms', label: 'Receipt footer text', type: 'textarea', span: true, rows: 2 },

      { type: 'section', label: 'Email' },
      {
        type: 'node',
        span: true,
        node: h('div', { class: 'alert info' },
          h('span', { class: 'ico' }, '✉'),
          h('div', {}, h('b', {}, 'Demo mode needs no setup.'),
            ' Messages are captured and can be opened exactly as the student would see them.'
            + ' Switch to "Send for real" once you have mail credentials — for Gmail that means'
            + ' a 16-character app password, not your normal one.')),
      },
      {
        name: 'mail_mode', label: 'Email sending', type: 'select', required: true, span: true,
        options: [
          { value: 'demo', label: 'Demo — capture messages, do not deliver' },
          { value: 'smtp', label: 'Send for real — through the mail server below' },
        ],
      },
      {
        name: 'smtp_host', label: 'SMTP host', placeholder: 'smtp.gmail.com',
        hint: 'The mail server\'s name — not your email address. Gmail: smtp.gmail.com',
      },
      {
        name: 'smtp_port', label: 'Port', type: 'number', min: '1', placeholder: '587',
        hint: '587 for STARTTLS, 465 for TLS.',
      },
      {
        name: 'smtp_user', label: 'Username', placeholder: 'you@gmail.com',
        hint: 'Usually the full email address you are sending from.',
      },
      {
        name: 'smtp_pass', label: 'Password', type: 'password',
        hint: 'Gmail needs a 16-character App Password, not your normal one. Stored on the server only.',
      },
      {
        name: 'smtp_from_email', label: 'Send from address', type: 'email', placeholder: 'you@gmail.com',
        hint: 'What students see as the sender. Gmail rewrites this unless it matches the account above.',
      },
      { name: 'smtp_from_name', label: 'Send from name', placeholder: 'Dhishaai Complete Analytics' },
      {
        name: 'smtp_secure', label: 'Force TLS from the first byte (port 465)', type: 'checkbox', span: true,
      },
      {
        name: 'enquiry_ack_enabled', type: 'checkbox', span: true,
        label: 'Email the enquirer an acknowledgement when a new enquiry is logged',
      },
      {
        name: 'enquiry_notify_internal', type: 'checkbox', span: true,
        label: `Also copy new enquiries to the institute inbox${s.email ? ` (${s.email})` : ''}`,
      },
      {
        name: 'enroll_welcome_enabled', type: 'checkbox', span: true,
        label: 'Email a welcome message when a student is enrolled in a course',
      },
      { name: 'enroll_welcome_subject', label: 'Welcome email subject', span: true },
      {
        name: 'enroll_welcome_message', label: 'Welcome message', type: 'textarea', span: true, rows: 8,
        hint: '{name}, {course}, {batch} and {institute} are filled in for each student.',
      },
    ], {
      ...s,
      smtp_secure: s.smtp_secure === '1',
      enquiry_ack_enabled: s.enquiry_ack_enabled === '1',
      enquiry_notify_internal: s.enquiry_notify_internal === '1',
      enroll_welcome_enabled: s.enroll_welcome_enabled === '1',
    });

    const save = h('button', {
      class: 'btn primary',
      onClick: async () => {
        const v = form.validate();
        if (!v) return;
        save.disabled = true;
        try {
          await api.put('/api/settings', {
            ...v,
            smtp_secure: v.smtp_secure ? '1' : '',
            enquiry_ack_enabled: v.enquiry_ack_enabled ? '1' : '',
            enquiry_notify_internal: v.enquiry_notify_internal ? '1' : '',
            enroll_welcome_enabled: v.enroll_welcome_enabled ? '1' : '',
          });
          await state.refreshMeta();
          toast('Settings saved', 'good');
        } catch (err) { toast(err.message, 'danger'); } finally { save.disabled = false; }
      },
    }, 'Save settings');

    /** Proves the settings above actually work, before a student depends on it. */
    const testEmail = h('button', {
      class: 'btn',
      onClick: () => formModal({
        title: 'Send a test email',
        size: 'narrow',
        fields: [{
          name: 'to', label: 'Send to', type: 'email', required: true, span: true,
          hint: 'Save your mail settings first — the test uses what is stored on the server.',
        }],
        values: { to: s.email || '' },
        submitLabel: 'Send test',
        async onSubmit(v, ctl) {
          await api.post('/api/settings/email-test', v);
          ctl.close();
          toast(`Test email sent to ${v.to}`, 'good');
        },
      }),
    }, '✉ Send a test email');

    /** Read what demo mode captured — the point of the demo. */
    const openOutbox = h('button', {
      class: 'btn',
      onClick: async () => {
        const data = await api.get('/api/outbox');
        openModal({
          title: `Demo outbox — ${data.rows.length} message(s)`,
          size: 'wide',
          body: h('div', {},
            h('div', { class: 'alert info', style: { marginBottom: '14px' } },
              h('span', { class: 'ico' }, '📬'),
              h('div', {}, data.mode === 'demo'
                ? 'Email is in demo mode: nothing is delivered, everything is kept here. Click a row to read it.'
                : 'Email is set to send for real, so new messages go out rather than landing here.')),
            dataTable({
              columns: [
                { key: 'sent_at', label: 'When', render: (r) => fmt.dateTime(r.sent_at) },
                { key: 'to', label: 'To' },
                { key: 'subject', label: 'Subject' },
                {
                  key: 'open', label: 'Message', align: 'center',
                  render: (r) => h('button', {
                    class: 'btn sm',
                    onClick: () => api.openTab(`/api/outbox/${r.id}`),
                  }, 'Open'),
                },
              ],
              rows: data.rows,
              onRow: (r) => api.openTab(`/api/outbox/${r.id}`),
              empty: 'Nothing captured yet',
              emptyHint: 'Log an enquiry, enroll a student, or email a receipt — it will appear here.',
            })),
          footer: [
            h('button', {
              class: 'btn danger',
              onClick: async () => {
                await api.del('/api/outbox');
                toast('Demo outbox cleared', 'good');
              },
            }, 'Clear outbox'),
          ],
        });
      },
    }, '📬 Demo outbox');

    return card('Institute profile', h('div', {},
      h('div', { class: 'alert info', style: { marginBottom: '16px' } },
        h('span', { class: 'ico' }, 'ℹ'),
        h('div', {}, 'These details appear on printed fee receipts and drive the numbering series.')),
      form.el,
      h('div', { style: { marginTop: '18px', display: 'flex', gap: '9px', flexWrap: 'wrap' } },
        isAdmin ? save : h('div', { class: 'muted small' },
          'Only an admin or owner can change these settings.'),
        isAdmin ? testEmail : null,
        isAdmin ? openOutbox : null)));
  }

  // -------------------------------------------------------- users
  async function users() {
    const rows = await api.get('/api/users');
    return card('Portal users', dataTable({
      columns: [
        {
          key: 'name', label: 'User', render: (r) => h('div', {},
            h('div', { class: 'strong' }, r.name),
            h('div', { class: 'small muted' }, r.email)),
        },
        { key: 'role', label: 'Role', render: (r) => badge(r.role, r.role === 'owner' ? 'accent' : 'navy') },
        { key: 'phone', label: 'Phone' },
        { key: 'last_login_at', label: 'Last sign-in', render: (r) => (r.last_login_at ? fmt.ago(r.last_login_at) : 'Never') },
        { key: 'active', label: 'Status', render: (r) => badge(r.active ? 'Active' : 'Disabled', r.active ? 'good' : 'danger') },
        {
          key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'row-actions' },
            h('button', { class: 'btn sm', onClick: () => userModal(r) }, '✎'),
            isOwner && r.id !== state.user.id
              ? h('button', { class: 'btn sm danger', onClick: () => removeUser(r) }, '×') : null),
        },
      ],
      rows,
      empty: 'No users',
    }), {
      flush: true,
      sub: 'Roles decide what each person can change',
      right: h('button', { class: 'btn sm primary', onClick: () => userModal() }, '+ Add user'),
    });
  }

  function userModal(u) {
    formModal({
      title: u ? `Edit ${u.name}` : 'Add a portal user',
      fields: [
        { name: 'name', label: 'Full name', required: true },
        { name: 'email', label: 'Email', type: 'email', required: !u, disabled: !!u },
        { name: 'phone', label: 'Phone', type: 'tel' },
        {
          name: 'role', label: 'Role', type: 'select', required: true,
          options: meta.enums.roles.filter((r) => isOwner || r !== 'owner'),
          hint: 'owner = everything · admin = everything except owner accounts · accounts = fees and payments · counsellor = leads and admissions · staff = attendance and tasks',
        },
        {
          name: 'password', label: u ? 'Reset password (optional)' : 'Password', type: 'password',
          required: !u, span: true, hint: 'At least 8 characters.',
        },
        u ? { name: 'active', label: 'Account is enabled', type: 'checkbox', span: true } : null,
      ].filter(Boolean),
      values: u || { role: 'staff' },
      submitLabel: u ? 'Save changes' : 'Create user',
      async onSubmit(v, ctl) {
        const payload = { ...v };
        if (u && !payload.password) delete payload.password;
        if (u) await api.put(`/api/users/${u.id}`, payload);
        else await api.post('/api/users', payload);
        ctl.close();
        toast(u ? 'User updated' : 'User created', 'good');
        load();
      },
    });
  }

  async function removeUser(u) {
    const go = await confirmDialog({
      title: 'Delete user',
      message: `Delete the account for ${u.name}? Their audit history is kept.`,
      danger: true, confirmLabel: 'Delete',
    });
    if (!go) return;
    try {
      await api.del(`/api/users/${u.id}`);
      toast('User deleted', 'good');
      load();
    } catch (err) { toast(err.message, 'danger', 6000); }
  }

  // ---------------------------------------------------- audit log
  async function audit() {
    const rows = await api.get('/api/audit', { limit: 300 });
    return card('Audit log', dataTable({
      columns: [
        { key: 'created_at', label: 'When', render: (r) => h('div', {},
          h('div', { class: 'small' }, fmt.dateTime(r.created_at)),
          h('div', { class: 'small muted' }, fmt.ago(r.created_at))) },
        { key: 'user_name', label: 'Who', render: (r) => h('span', { class: 'strong' }, r.user_name || 'system') },
        { key: 'action', label: 'Action', render: (r) => badge(r.action, r.action === 'delete' ? 'danger' : r.action === 'create' ? 'good' : 'navy') },
        { key: 'entity', label: 'What', render: (r) => h('span', {}, r.entity.replace(/_/g, ' ')) },
        { key: 'detail', label: 'Detail', render: (r) => h('span', { class: 'small' }, r.detail || '—') },
      ],
      rows,
      empty: 'Nothing logged yet',
    }), { flush: true, sub: 'Every create, update, delete and sign-in, newest first' });
  }

  // -------------------------------------------------- data & backup
  async function data() {
    const stats = await api.get('/api/settings/stats');
    const rows = Object.entries(stats.tables).map(([table, count]) => ({ table: table.replace(/_/g, ' '), count }));

    const restoreInput = h('input', { type: 'file', accept: '.json', style: { display: 'none' } });
    restoreInput.addEventListener('change', async () => {
      const file = restoreInput.files[0];
      if (!file) return;
      const go = await confirmDialog({
        title: 'Restore from backup',
        message: `Restoring “${file.name}” deletes every current record and replaces it with the file's contents. This cannot be undone.`,
        danger: true,
        confirmLabel: 'Restore and replace',
        requirePhrase: 'REPLACE ALL DATA',
      });
      restoreInput.value = '';
      if (!go) return;
      try {
        const dump = JSON.parse(await file.text());
        const out = await api.post('/api/restore', { dump, confirm: 'REPLACE ALL DATA' });
        toast(`${out.restored} rows restored. Reloading…`, 'good');
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) { toast(err.message, 'danger', 7000); }
    });

    return h('div', { class: 'grid c2' },
      card('Backup & restore', h('div', {},
        h('p', { class: 'small muted' },
          'A backup is a single JSON file containing every record. Keep a copy off this machine — ',
          'the database itself lives at the path shown under “Storage”.'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' } },
          h('button', { class: 'btn primary', onClick: () => api.download('/api/backup') }, '↓ Download backup'),
          isOwner ? h('button', { class: 'btn', onClick: () => restoreInput.click() }, '↑ Restore from file') : null,
          restoreInput),
        isOwner
          ? h('div', { style: { marginTop: '22px', paddingTop: '18px', borderTop: '1px solid var(--line)' } },
            h('div', { class: 'strong', style: { marginBottom: '4px' } }, 'Clear the demo data'),
            h('p', { class: 'small muted' },
              'Removes the sample students, enquiries, payments and expenses that ship with a fresh install. ',
              'Courses, batches, fee plans and staff are kept.'),
            h('button', { class: 'btn danger', style: { marginTop: '8px' }, onClick: clearDemo }, 'Clear demo data'))
          : null)),
      card('Storage', h('div', {},
        h('dl', { class: 'kv', style: { marginBottom: '16px' } },
          h('dt', {}, 'Database file'), h('dd', { class: 'small mono' }, stats.database),
          h('dt', {}, 'Driver'), h('dd', {}, stats.driver)),
        dataTable({
          columns: [
            { key: 'table', label: 'Table' },
            { key: 'count', label: 'Rows', align: 'right', render: (r) => h('span', { class: 'mono' }, fmt.num(r.count)) },
          ],
          rows,
          empty: 'No tables',
        }))));
  }

  async function clearDemo() {
    const go = await confirmDialog({
      title: 'Clear demo data',
      message: 'This deletes every student, enquiry, enrollment, payment, expense and task. Courses, batches, fee plans and staff stay.',
      danger: true,
      confirmLabel: 'Clear it',
      requirePhrase: 'CLEAR DEMO DATA',
    });
    if (!go) return;
    try {
      await api.post('/api/settings/clear-demo', { confirm: 'CLEAR DEMO DATA' });
      toast('Demo data cleared. Reloading…', 'good');
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) { toast(err.message, 'danger', 7000); }
  }

  // -------------------------------------------------------- import
  /*
   * Bringing an existing spreadsheet in.
   *
   * Four steps, in this order on purpose: open the file, say what the sheet
   * holds, check the columns were understood, then look at what would happen
   * before anything happens. Nothing is written until the last button.
   */
  async function importSheet() {
    const { targets } = await api.get('/api/import/targets');
    const host = h('div', {});
    // everything the wizard knows; redrawn from this and nothing else
    const st = { file: null, sheets: [], sheet: null, target: '', mapping: {}, preview: null, busy: false };

    const pickFile = h('input', {
      type: 'file', accept: '.xlsx,.csv,.txt', style: { display: 'none' },
      onChange: async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = async () => {
          st.file = { name: f.name, data: String(reader.result), size: f.size };
          st.sheet = null; st.target = ''; st.mapping = {}; st.preview = null;
          try {
            const out = await api.post('/api/import/read', { filename: f.name, data: st.file.data });
            st.sheets = out.sheets;
            st.sheet = out.sheets[0] ? out.sheets[0].name : null;
          } catch (err) { st.file = null; toast(err.message, 'danger', 8000); }
          draw();
        };
        reader.readAsDataURL(f);
      },
    });

    const sheetNow = () => st.sheets.find((s) => s.name === st.sheet) || null;

    async function loadPreview(useMapping) {
      const s = sheetNow();
      if (!st.target || !s) return;
      st.busy = true; draw();
      try {
        st.preview = await api.post('/api/import/preview', {
          filename: st.file.name, data: st.file.data, sheet: st.sheet,
          target: st.target, mapping: useMapping ? st.mapping : null,
        });
        st.mapping = { ...st.preview.mapping };
      } catch (err) { toast(err.message, 'danger', 8000); }
      st.busy = false;
      draw();
    }

    async function commit() {
      const p = st.preview;
      const go = await confirmDialog({
        title: `Import ${p.summary.create + p.summary.update} row(s)?`,
        message: `${p.summary.create} new record(s) will be created and ${p.summary.update} existing one(s) `
          + `updated. ${p.summary.reject} rejected row(s) will be left out entirely. `
          + 'Take a backup first if you have not — Settings → Data & backup.',
        confirmLabel: 'Import them',
      });
      if (!go) return;
      st.busy = true; draw();
      try {
        const out = await api.post('/api/import/commit', {
          filename: st.file.name, data: st.file.data, sheet: st.sheet,
          target: st.target, mapping: st.mapping,
        });
        toast(`${out.summary.create} created · ${out.summary.update} updated`, 'good', 7000);
        await state.refreshMeta();
        openModal({
          title: 'Imported',
          size: 'wide',
          body: h('div', {},
            h('div', { class: 'tiles', style: { marginBottom: '14px' } },
              statTile({ label: 'Created', value: fmt.num(out.summary.create), tone: 'good' }),
              statTile({ label: 'Updated', value: fmt.num(out.summary.update) }),
              statTile({
                label: 'Left out', value: fmt.num(out.summary.reject),
                tone: out.summary.reject ? 'warn' : '',
              })),
            out.summary.reject
              ? h('div', {},
                h('p', { class: 'small muted', style: { marginBottom: '8px' } },
                  'These rows were not imported. Fix them in the sheet and import the file '
                  + 'again — rows that already landed will be recognised and updated, not duplicated.'),
                rejectTable(out.rows))
              : h('p', { class: 'small muted' }, 'Every row went in.')),
        });
        st.preview = null;
        st.file = null;
        draw();
      } catch (err) { toast(err.message, 'danger', 9000); st.busy = false; draw(); }
    }

    const rejectTable = (rows) => dataTable({
      columns: [
        { key: 'line', label: 'Row', align: 'right', render: (r) => h('span', { class: 'mono' }, r.line) },
        { key: 'label', label: 'What it says' },
        {
          key: 'why', label: 'Why it was left out',
          render: (r) => h('div', { class: 'small' },
            Object.entries(r.errors || {}).map(([, msg]) => h('div', {}, msg))),
        },
      ],
      rows,
      empty: 'None',
    });

    function draw() {
      clear(host);

      /* ---- step 1: the file ---- */
      host.appendChild(card('Import from a spreadsheet', h('div', {},
        h('div', { class: 'alert info', style: { marginBottom: '16px' } },
          h('span', { class: 'ico' }, 'ℹ'),
          h('div', {},
            h('b', {}, 'Import in this order: courses, then staff, then batches, then students. '),
            'Each one points at the one before it — a batch cannot find a course that is not in yet. ',
            h('br'),
            'Nothing is written until you have seen the preview and pressed Import.')),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { class: 'btn primary', onClick: () => pickFile.click() },
            st.file ? 'Choose a different file' : '📄 Choose an Excel or CSV file'),
          pickFile,
          st.file
            ? h('span', { class: 'small' }, h('b', {}, st.file.name),
              ` · ${(st.file.size / 1024).toFixed(0)} KB`)
            : h('span', { class: 'small muted' }, '.xlsx or .csv — the sheet is read here, nothing is sent anywhere else')),
        st.file && st.sheets.length > 1
          ? h('div', { style: { marginTop: '14px' } },
            h('label', { class: 'small strong' }, 'Which sheet? '),
            h('select', {
              class: 'input', style: { maxWidth: '340px', marginTop: '6px' },
              onChange: (e) => { st.sheet = e.target.value; st.preview = null; st.mapping = {}; draw(); },
            }, st.sheets.map((s) => h('option', {
              value: s.name, selected: s.name === st.sheet,
            }, `${s.name} — ${s.rows} row(s)`))))
          : null)));

      const s = sheetNow();
      if (!s) return;

      /* ---- step 2: what the sheet holds ---- */
      host.appendChild(card(`What is in "${s.name}"?`, h('div', {},
        h('p', { class: 'small muted', style: { marginBottom: '12px' } },
          `${s.rows} row(s), ${s.headers.length} column(s): ${s.headers.slice(0, 12).join(' · ')}`
          + (s.headers.length > 12 ? ' …' : '')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          targets.map((t) => h('button', {
            class: `btn ${st.target === t.key ? 'primary' : ''}`,
            onClick: () => { st.target = t.key; st.mapping = {}; loadPreview(false); },
          }, t.label))),
        st.target
          ? h('p', { class: 'small muted', style: { marginTop: '10px' } },
            targets.find((t) => t.key === st.target).hint)
          : null)));

      if (st.busy) { host.appendChild(loading()); return; }
      const p = st.preview;
      if (!p) return;

      /* ---- step 3: the columns ---- */
      const fields = targets.find((t) => t.key === st.target).fields;
      host.appendChild(card('Which column is which', h('div', {},
        h('p', { class: 'small muted', style: { marginBottom: '12px' } },
          'Guessed from the column names. Correct anything that went to the wrong place — '
          + 'a column set to "not in this sheet" is simply not imported.'),
        h('div', { class: 'form-grid' }, fields.map((f) => h('div', { class: 'field' },
          h('label', {}, f.label, f.required ? h('span', { style: { color: 'var(--danger)' } }, ' *') : null),
          h('select', {
            class: 'input',
            onChange: (e) => { st.mapping[f.name] = e.target.value; loadPreview(true); },
          },
          h('option', { value: '' }, '— not in this sheet —'),
          p.headers.map((hh) => h('option', {
            value: hh, selected: st.mapping[f.name] === hh,
          }, hh)))))),
        p.unmapped.length
          ? h('div', { class: 'small muted', style: { marginTop: '10px' } },
            `Not used from your sheet: ${p.unmapped.join(' · ')}`)
          : null)));

      /* ---- step 4: what would happen ---- */
      const canGo = p.summary.create + p.summary.update > 0;
      host.appendChild(card('What this would do', h('div', {},
        h('div', { class: 'tiles', style: { marginBottom: '14px' } },
          statTile({ label: 'To be created', value: fmt.num(p.summary.create), tone: 'good' }),
          statTile({ label: 'Already here — will be updated', value: fmt.num(p.summary.update) }),
          statTile({
            label: 'Cannot be imported', value: fmt.num(p.summary.reject),
            tone: p.summary.reject ? 'warn' : '',
            sub: p.summary.reject ? 'listed below, with the reason' : 'nothing rejected',
          })),
        dataTable({
          columns: [
            { key: 'line', label: 'Row', align: 'right', render: (r) => h('span', { class: 'mono' }, r.line) },
            { key: 'label', label: 'Record' },
            {
              key: 'action',
              label: 'What happens',
              render: (r) => badge(
                { create: 'New', update: 'Updates existing', reject: 'Left out', skip: 'Skipped' }[r.action],
                { create: 'good', update: 'navy', reject: 'danger', skip: 'warn' }[r.action],
              ),
            },
            {
              key: 'detail', label: 'Detail', render: (r) => h('div', { class: 'small muted' },
                Object.entries(r.errors || {}).map(([, msg]) => h('div', { style: { color: 'var(--danger)' } }, msg)),
                (r.warnings || []).map((w) => h('div', {}, w)),
                r.action === 'update' && r.existing
                  ? h('div', {}, `matches ${r.existing.name} already in the portal`) : null),
            },
          ],
          rows: p.rows,
          empty: 'Nothing in this sheet',
        }),
        p.truncated
          ? h('div', { class: 'small muted', style: { marginTop: '8px' } },
            `…and ${p.truncated} more row(s), counted above but not listed here.`)
          : null,
        h('div', { style: { marginTop: '16px', display: 'flex', gap: '9px', flexWrap: 'wrap' } },
          h('button', {
            class: 'btn primary', disabled: !canGo, onClick: commit,
          }, canGo
            ? `↑ Import ${p.summary.create + p.summary.update} row(s)`
            : 'Nothing can be imported yet'),
          h('button', { class: 'btn', onClick: () => loadPreview(true) }, 'Look again')))));
    }

    draw();
    return host;
  }

  // ------------------------------------------------- announcements
  /*
   * Telling a batch when their classes begin.
   *
   * The welcome email goes out when a student enrolls, which is usually before
   * anyone knows the first morning. This is where that gets said — written
   * once for the batch, addressed to each student by name, and sent only when
   * the Send button is pressed. Nothing on this screen fires by itself.
   */
  async function announce() {
    const batchList = meta.lookups.batches;
    if (!batchList.length) {
      return card(null, h('div', { class: 'dt-empty' },
        h('div', { class: 'big' }, '◍'),
        h('div', {}, 'No planned or ongoing batches'),
        h('div', { class: 'small muted' }, 'Create a batch first — an announcement is addressed to one.')));
    }

    let data = await api.get('/api/announcements/recipients', {
      batch_id: query.batch_id || batchList[0].id,
    });
    // everyone who can actually be written to, ticked to begin with
    let picked = new Set(data.rows.filter((r) => r.email).map((r) => r.student_id));

    const listHost = h('div', {});
    const noteHost = h('div', {});

    const form = buildForm([
      {
        name: 'batch_id', label: 'Batch', type: 'select', required: true,
        options: batchList.map((b) => ({
          value: b.id,
          label: `${b.code} · starts ${fmt.batch(b.start_date) || '—'} · ${b.status} · ${b.filled} student(s)`,
        })),
      },
      {
        name: 'start_date', label: 'Classes start on', type: 'date', required: true,
        hint: 'This exact date is what the students are told.',
      },
      {
        name: 'update_batch', type: 'checkbox', span: true,
        label: 'Also move the batch’s own start date to match what I am announcing',
      },
      { name: 'subject', label: 'Subject', span: true, required: true },
      {
        name: 'message', label: 'Message', type: 'textarea', rows: 12, span: true, required: true,
        hint: '{name}, {course}, {batch}, {start_date}, {time}, {trainer}, {mode} and {institute} '
          + 'are filled in for each student. A line whose only value is empty — "Trainer:" with '
          + 'nobody assigned — is left out rather than sent blank.',
      },
    ], {
      batch_id: data.batch.id,
      start_date: data.batch.start_date,
      subject: data.template.subject,
      message: data.template.message,
    });

    const sendBtn = h('button', { class: 'btn primary' }, '✉ Send');

    /** The roster, with a tick against everyone who is to be written to. */
    function drawList() {
      const missing = data.rows.filter((r) => !r.email);
      // named here rather than in the card heading, which does not get rebuilt
      // when the batch changes and would go on naming the previous course
      clear(listHost).appendChild(h('div', {
        class: 'small muted', style: { padding: '12px 16px 0' },
      }, `${data.batch.code} · ${data.batch.course_name}`
        + (data.batch.trainer_name ? ` · ${data.batch.trainer_name}` : '')));
      listHost.appendChild(dataTable({
        columns: [
          {
            key: 'pick', label: '', align: 'center',
            render: (r) => (r.email
              ? h('input', {
                type: 'checkbox',
                checked: picked.has(r.student_id),
                onChange: (e) => {
                  if (e.target.checked) picked.add(r.student_id); else picked.delete(r.student_id);
                  paintCount();
                },
              })
              : h('span', { class: 'small muted' }, '—')),
          },
          {
            key: 'name', label: 'Student', render: (r) => h('div', {},
              h('div', { class: 'strong' }, r.name),
              h('div', { class: 'small muted' }, r.reg_no)),
          },
          {
            key: 'email', label: 'Email', render: (r) => (r.email
              ? h('span', { class: 'small' }, r.email)
              : badge('No email on record', 'warn')),
          },
          {
            key: 'enrollment_status', label: 'Enrollment',
            render: (r) => badge(r.enrollment_status, r.enrollment_status === 'Active' ? 'good' : 'navy'),
          },
        ],
        rows: data.rows,
        empty: 'Nobody is enrolled in this batch yet',
        emptyHint: 'Enroll students into the batch and they will appear here.',
      }));
      if (missing.length) {
        listHost.appendChild(h('div', { class: 'alert warn', style: { marginTop: '12px' } },
          h('span', { class: 'ico' }, '!'),
          h('div', {}, h('b', {}, `${missing.length} student(s) cannot be emailed.`),
            ` ${missing.map((r) => r.name).join(', ')} — no email address on their student record. `
            + 'Add one on their profile, or tell them another way.')));
      }
      paintCount();
    }

    /** Keep the button honest about how many people it is about to write to. */
    function paintCount() {
      sendBtn.textContent = picked.size
        ? `✉ Send to ${picked.size} student${picked.size === 1 ? '' : 's'}`
        : '✉ Nobody ticked';
      sendBtn.disabled = picked.size === 0;
    }

    /** What the portal holds against what is being announced. */
    function drawNote() {
      const announced = form.read().start_date;
      const recorded = data.batch.start_date;
      clear(noteHost);
      if (announced && recorded && announced !== recorded) {
        noteHost.appendChild(h('div', { class: 'alert warn', style: { marginBottom: '14px' } },
          h('span', { class: 'ico' }, '!'),
          h('div', {}, h('b', {}, 'That is not the date on the batch. '),
            `${data.batch.code} is recorded as starting ${fmt.date(recorded)}. `
            + 'Tick the box above to move the batch too, or leave it and only the email changes.')));
      }
    }

    form.el.addEventListener('change', async (e) => {
      if (e.target === form.controls.batch_id.input) {
        const keep = form.read();       // whatever wording is on screen stays
        data = await api.get('/api/announcements/recipients', { batch_id: keep.batch_id });
        picked = new Set(data.rows.filter((r) => r.email).map((r) => r.student_id));
        form.controls.start_date.input.value = data.batch.start_date || '';
        setQuery({ tab: 'announce', batch_id: keep.batch_id });
        drawList();
      }
      drawNote();
    });

    /** Exactly what the first student will receive — rendered by the server. */
    const previewBtn = h('button', {
      class: 'btn',
      onClick: async () => {
        const v = form.validate();
        if (!v) return;
        try {
          const out = await api.post('/api/announcements/class-start', {
            ...v, student_ids: [...picked], preview: 1,
          });
          openModal({
            title: 'This is what they will read',
            size: 'wide',
            body: h('div', {},
              h('dl', { class: 'kv' },
                h('dt', {}, 'To'), h('dd', { class: 'small' }, out.preview.to),
                h('dt', {}, 'Subject'), h('dd', { class: 'strong' }, out.preview.subject)),
              h('pre', {
                style: {
                  marginTop: '14px', padding: '14px', background: 'var(--bg-soft, #f6f7f9)',
                  borderRadius: '8px', whiteSpace: 'pre-wrap', font: '14px/1.65 Segoe UI, Arial, sans-serif',
                },
              }, out.preview.text),
              h('div', { class: 'small muted', style: { marginTop: '10px' } },
                `${out.recipients} student(s) would be written to`
                + (out.skipped ? `, ${out.skipped} skipped for want of an email address` : ''))),
          });
        } catch (err) { form.setErrors(err.fields || {}); toast(err.message, 'danger', 6000); }
      },
    }, '👁 Preview');

    sendBtn.addEventListener('click', async () => {
      const v = form.validate();
      if (!v) return;
      const go = await confirmDialog({
        title: `Email ${picked.size} student(s)?`,
        message: `They will be told that ${data.batch.course_name} (${data.batch.code}) starts on `
          + `${fmt.date(v.start_date)}.`
          + (data.mail_mode === 'demo'
            ? ' Email is in demo mode, so nothing is delivered — the messages are kept in the demo outbox.'
            : ' This sends real email.'),
        confirmLabel: data.mail_mode === 'demo' ? 'Send (demo)' : 'Send it',
      });
      if (!go) return;
      sendBtn.disabled = true;
      const original = sendBtn.textContent;
      sendBtn.textContent = 'Sending…';
      try {
        const out = await api.post('/api/announcements/class-start', {
          ...v, student_ids: [...picked],
        });
        toast(out.sent
          ? `Told ${out.sent} student(s) that classes start ${fmt.date(out.start_date)}`
          : 'Nothing went out', out.sent ? 'good' : 'danger', 6000);
        openModal({
          title: `${out.sent} sent · ${out.failed} failed · ${out.skipped} skipped`,
          size: 'wide',
          body: h('div', {},
            out.demo
              ? h('div', { class: 'alert info', style: { marginBottom: '14px' } },
                h('span', { class: 'ico' }, '📬'),
                h('div', {}, 'Email is in demo mode, so nothing was delivered. Every message is kept — '
                  + 'Settings → Institute → Demo outbox opens them exactly as the student would see them.'))
              : null,
            out.batch_updated
              ? h('div', { class: 'alert good', style: { marginBottom: '14px' } },
                h('span', { class: 'ico' }, '✓'),
                h('div', {}, `${out.batch} now starts ${fmt.date(out.start_date)} on the batch too.`))
              : null,
            dataTable({
              columns: [
                { key: 'name', label: 'Student' },
                { key: 'email', label: 'Email', render: (r) => h('span', { class: 'small' }, r.email || '—') },
                {
                  key: 'ok', label: 'Result',
                  render: (r) => (r.ok ? badge('Sent', 'good') : badge('Not sent', 'danger')),
                },
                { key: 'reason', label: 'Why not', render: (r) => h('span', { class: 'small muted' }, r.reason || '') },
              ],
              rows: out.results,
              empty: 'Nothing to report',
            })),
        });
        if (out.batch_updated) await state.refreshMeta();
      } catch (err) {
        form.setErrors(err.fields || {});
        toast(err.message, 'danger', 7000);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = original;
        paintCount();
      }
    });

    /** Keep this wording for next time, without sending anything now. */
    const saveWording = h('button', {
      class: 'btn',
      onClick: async () => {
        const v = form.read();
        if (!v.subject.trim() || !v.message.trim()) {
          toast('There is no wording to save', 'danger');
          return;
        }
        try {
          await api.put('/api/settings', {
            class_start_subject: v.subject, class_start_message: v.message,
          });
          toast('Saved — this is the wording the next batch starts from', 'good');
        } catch (err) { toast(err.message, 'danger'); }
      },
    }, 'Save this wording');

    drawList();
    drawNote();

    return h('div', {},
      card('Tell a batch when their classes begin', h('div', {},
        h('div', { class: 'alert info', style: { marginBottom: '16px' } },
          h('span', { class: 'ico' }, '✉'),
          h('div', {}, h('b', {}, 'Nothing here sends on its own. '),
            'The welcome email goes out the moment a student enrolls, weeks before the first '
            + 'morning is settled. This is the message that names the day — written once, '
            + 'addressed to each student, sent when you press the button.')),
        noteHost,
        form.el,
        h('div', { style: { marginTop: '18px', display: 'flex', gap: '9px', flexWrap: 'wrap' } },
          sendBtn, previewBtn, saveWording),
        !data.mail_ready
          ? h('div', { class: 'alert warn', style: { marginTop: '14px' } },
            h('span', { class: 'ico' }, '!'),
            h('div', {}, 'Email is not set up yet — Settings → Institute → Email. Until it is, '
              + 'nothing can go out.'))
          : null)),
      card('Who will be written to', listHost, {
        flush: true,
        sub: 'Untick anyone who should not get this message. Dropped enrollments are never listed.',
      }));
  }

  // -------------------------------------------------------- about
  async function about() {
    return h('div', { class: 'grid c2' },
      card('Dhishaai Admin Portal', h('div', {},
        h('p', { class: 'small' },
          'A single place to run the institute: enquiries and follow-ups, admissions, courses, batches, ',
          'attendance, fee structures, instalments, receipts, expenses, placements and reports.'),
        h('dl', { class: 'kv', style: { marginTop: '14px' } },
          h('dt', {}, 'Signed in as'), h('dd', {}, `${state.user.name} (${state.user.role})`),
          h('dt', {}, 'Institute'), h('dd', {}, meta.settings.institute_name),
          h('dt', {}, 'Academic year'), h('dd', {}, meta.settings.academic_year)))),
      card('Keyboard & tips', h('div', {},
        h('dl', { class: 'kv' },
          h('dt', {}, 'Press /'), h('dd', {}, 'Jump to global search'),
          h('dt', {}, 'Esc'), h('dd', {}, 'Close any dialog'),
          h('dt', {}, 'Pipeline'), h('dd', {}, 'Drag a card between columns to change a student’s stage'),
          h('dt', {}, 'Receipts'), h('dd', {}, 'Open a receipt, then use your browser’s Print → Save as PDF'),
          h('dt', {}, 'Backups'), h('dd', {}, 'Run npm run backup for a timestamped copy of the database')))));
  }

  host.appendChild(pageHead('Settings', 'Institute profile, users, student announcements, audit trail and backups'));
  host.appendChild(drawTabs());
  host.appendChild(bodyHost);
  await load();
  return host;
}
