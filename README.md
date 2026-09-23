# Dhishaai Admin Portal

Student, fee and end-to-end lifecycle management for **Dhishaai Complete Analytics**.

A single self-hosted web app: enquiries → admissions → batches → attendance →
fees and receipts → placements, with reporting over all of it.

**Zero npm dependencies.** The whole thing runs on Node's built-in HTTP server
and built-in SQLite. There is no `npm install`, no build step, no bundler, and
nothing to compile.

---

## Running it

```bash
cd dhishaai-admin
npm start
```

Then open <http://localhost:4000>.

On the very first run the app creates the database, loads demo data, and prints
the owner account to the terminal:

```
email     admin@dhishaai.com
password  dhishaai@2026
```

Change that password from **Settings → Users** straight away.

Requires **Node.js 22.5 or newer** (for `node:sqlite`). Node 24 LTS is what this
was built and tested against.

| Command | What it does |
|---|---|
| `npm start` | Start the server (`PORT=8080 npm start` to change the port) |
| `npm run seed` | Create the owner account / demo data if missing |
| `npm run reset` | Wipe everything and re-seed the demo data |
| `npm run backup` | Copy the database to `data/backups/` (keeps the last 20) |

> **Putting this on a server?** Read **[DEPLOYMENT.md](DEPLOYMENT.md)** first. The
> steps above are for a laptop: they leave the portal on plain HTTP with the
> published default password, which is fine at a desk and not fine on a network.
> The guide covers running it as a service, TLS, file permissions and backups,
> with scripts for each under [`deploy/`](deploy/).

To start with an empty system instead of the demo data, set
`DHISHAAI_NO_DEMO=1` before the first run — or load the demo, look around, then
use **Settings → Data → Clear demo data**.

---

## What it does

### The lifecycle it tracks

```
Enquiry ─▶ Follow-ups ─▶ Convert ─▶ Student
                                      │
                                      ├─▶ Enrollment ─▶ Fee plan ─▶ Instalments ─▶ Receipts
                                      ├─▶ Batch ─▶ Attendance
                                      └─▶ Stages: Admitted ─▶ Documents Pending ─▶ Training
                                                 ─▶ Project ─▶ Certification
                                                 ─▶ Placement Ready ─▶ Placed / Completed
```

Every stage move is written to `stage_history` with who moved it and when.

### Screens

| Screen | What lives there |
|---|---|
| **Dashboard** | KPI tiles, 12-month collections vs expenses, admissions trend, alerts, fees due, follow-ups due, recent receipts, activity feed |
| **Student pipeline** | Kanban board — drag a card between columns to change the stage |
| **Enquiries** | Lead capture, priority, owner, follow-up log, conversion funnel, one-click convert to student |
| **Students** | Searchable list with live fee balances; a 360° profile per student (enrollments, instalments, receipts, documents, attendance, placements, stage history) |
| **Enrollments** | Every student × course pairing, batch assignment, discounts, balances |
| **Courses** | Catalogue, syllabus modules, and the fee plans attached to each course |
| **Batches** | Schedule, trainer, capacity and seat fill, roster, generated session calendar |
| **Attendance** | Pick a batch and date, mark the sheet, see the running percentage per student |
| **Staff & trainers** | Team records and their batch load |
| **Fees & dues** | Fee-plan templates with an instalment editor, plus every outstanding and overdue instalment |
| **Payments** | Receipt register, day-book, printable A4 receipts, voiding with a reason |
| **Expenses** | Operating spend by category, so "net this month" is a real figure |
| **Placements** | Applications, interviews, offers, packages, placement rate |
| **Tasks** | Shared to-do list for the front desk |
| **Reports** | Nine reports (collections, day book, cash summary, unpaid fee by date, student ledger, revenue by course, batch performance, admissions vs enquiries, lead sources) — each with a chart, a table and CSV export |
| **Settings** | Institute profile, numbering series, users and roles, audit log, backup / restore |

---

## How fees work

This is the part worth understanding before you enter real data.

1. A **course** has a base fee.
2. A **fee plan** is a reusable template on that course — for example
   *"Pay in full"* (one line) or *"3 instalments"* (three lines, each with a
   due-date offset in days from the joining date). The lines must add up to the
   plan total; the editor checks this live.
3. When you **enroll** a student, the plan is **copied** into that student's own
   `installments` rows, with real dates. Editing the plan template afterwards
   never disturbs a schedule that has already been issued.
4. A **payment** is recorded against an enrollment and allocated across the open
   instalments, **earliest due date first**. You can override the allocation.
5. **Voiding** a receipt keeps it for the audit trail (stamped VOID on the
   printout) and reverses its allocations, so reports self-correct.
6. **Waiving** an instalment reduces the enrollment's payable fee and records the
   reason. It is reversible.

Guard rails the API enforces: you cannot reprice an enrollment below what has
already been collected, cannot reduce an instalment below its paid amount, and
cannot overpay a balance without explicitly confirming it as an advance.

---

## Roles

| Role | Can change |
|---|---|
| `owner` | Everything, including other owner accounts, restore and demo-clear |
| `admin` | Everything except owner accounts |
| `accounts` | Payments, instalments, fee plans, expenses, students, enrollments |
| `counsellor` | Enquiries, follow-ups, students, enrollments, placements |
| `staff` | Attendance, tasks, follow-ups |

Everyone can read everything. Passwords are hashed with scrypt; sessions are
HttpOnly cookies valid for 7 days.

---

## Layout

```
dhishaai-admin/
├─ server.js                  HTTP server, static files, error handling
├─ package.json               scripts only — no dependencies
├─ data/dhishaai.db           created on first run (git-ignored)
├─ src/
│  ├─ schema.sql              24 tables
│  ├─ db.js                   SQLite adapter (node:sqlite → better-sqlite3 fallback)
│  ├─ util.js                 money, dates, validation, CSV
│  ├─ auth.js                 scrypt, sessions, role gates, audit
│  ├─ settings.js             key/value settings + reg-no / receipt-no series
│  ├─ constants.js            shared enums (also served to the browser)
│  ├─ seed.js                 owner account + demo data
│  ├─ backup.js               npm run backup
│  ├─ router.js               pattern router
│  └─ routes/                 16 API modules
└─ public/
   ├─ index.html
   └─ assets/
      ├─ css/app.css          brand navy #0F3D5C / orange #F47920, light + dark
      └─ js/
         ├─ app.js            shell, auth gate, navigation
         ├─ api.js  router.js  ui.js  charts.js
         └─ pages/            17 screens
```

The browser code is plain ES modules — open a file, edit it, refresh. No build.

---

## Notes

- **Charts** are hand-rolled SVG. Series colours come from a colourblind-safe
  categorical palette (validated for CVD separation in both light and dark
  mode); the Dhishaai navy and orange are used for UI chrome rather than for
  data marks, so two series are never told apart by brand colour alone.
- **Documents** are tracked, not stored. The portal records that an Aadhaar or
  marksheet was collected and verified; keep the files themselves wherever you
  keep them today.
- **Receipts** are server-rendered HTML — open one and use the browser's
  Print → Save as PDF.
- **Backups**: `npm run backup` copies the database file. Settings → Data
  downloads a JSON dump instead, which the same screen can restore. Keep a copy
  off this machine.
- **Access from other machines on the office LAN**: the server already listens on
  all interfaces, so `http://<this-pc-ip>:4000` works once Windows Firewall is
  allowed to accept it. There is no HTTPS — keep it on the local network.
