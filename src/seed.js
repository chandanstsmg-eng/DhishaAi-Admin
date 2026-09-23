'use strict';
/**
 * First-run setup.
 *
 *   ensureSeeded()          creates the owner account (and demo data once)
 *   node src/seed.js        same, standalone
 *   node src/seed.js --reset  wipes transactional data and re-seeds the demo
 */

const { db, migrate } = require('./db');
const auth = require('./auth');
const settings = require('./settings');
const { nowIso, today, addDays, money } = require('./util');
const C = require('./constants');

const DEFAULT_ADMIN = {
  name: 'Dhishaai Admin',
  email: process.env.ADMIN_EMAIL || 'admin@dhishaai.com',
  password: process.env.ADMIN_PASSWORD || 'dhishaai@2026',
  role: 'owner',
};

// A tiny deterministic PRNG keeps demo data stable across re-seeds.
let seedState = 20260727;
const rnd = () => {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function createOwner() {
  const { hash, salt } = auth.hashPassword(DEFAULT_ADMIN.password);
  db.run(
    `INSERT INTO users (name, email, phone, password_hash, salt, role, active, created_at)
     VALUES (?,?,?,?,?,?,1,?)`,
    [DEFAULT_ADMIN.name, DEFAULT_ADMIN.email, '', hash, salt, DEFAULT_ADMIN.role, nowIso()],
  );
  console.log('\n  Owner account created');
  console.log(`    email     ${DEFAULT_ADMIN.email}`);
  console.log(`    password  ${DEFAULT_ADMIN.password}`);
  console.log('    Change this from Settings → Users after your first sign-in.\n');
}

// ------------------------------------------------------------ demo data
const COURSES = [
  ['DA-101', 'Data Analytics Foundation', 'Analytics', 12, 96, 35000, ['Excel & Statistics', 'SQL for Analysts', 'Power BI', 'Capstone Project']],
  ['DS-201', 'Data Science with Python', 'Data Science', 24, 200, 65000, ['Python Programming', 'NumPy & Pandas', 'Machine Learning', 'Deep Learning', 'Capstone Project']],
  ['BI-105', 'Power BI Specialist', 'Business Intelligence', 8, 60, 22000, ['Data Modelling', 'DAX', 'Dashboard Design']],
  ['SQL-102', 'Advanced SQL & Databases', 'Analytics', 6, 48, 15000, ['Joins & Subqueries', 'Window Functions', 'Query Tuning']],
  ['ML-301', 'Machine Learning Engineering', 'Data Science', 20, 160, 78000, ['Feature Engineering', 'Model Training', 'MLOps', 'Deployment']],
  ['FS-110', 'Full Stack Analytics', 'Programming', 16, 130, 55000, ['JavaScript Basics', 'APIs', 'Dashboards', 'Project']],
];

const STAFF = [
  ['Ramya Krishnan', 'ramya@dhishaai.com', '9845012301', 'Trainer', 'Python, Machine Learning'],
  ['Arun Prakash', 'arun@dhishaai.com', '9845012302', 'Trainer', 'SQL, Power BI'],
  ['Divya Menon', 'divya@dhishaai.com', '9845012303', 'Counsellor', 'Admissions'],
  ['Karthik Iyer', 'karthik@dhishaai.com', '9845012304', 'Placement Officer', 'Corporate relations'],
  ['Sneha Rao', 'sneha@dhishaai.com', '9845012305', 'Trainer', 'Statistics, Excel'],
  ['Vikram Shetty', 'vikram@dhishaai.com', '9845012306', 'Accounts', 'Fees and compliance'],
];

const FIRST = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikas', 'Meera', 'Sanjay', 'Kavya', 'Nikhil', 'Divya',
  'Rahul', 'Shreya', 'Aditya', 'Pooja', 'Manoj', 'Lakshmi', 'Harish', 'Nithya', 'Suresh', 'Anjali',
  'Varun', 'Deepika', 'Kiran', 'Swathi', 'Ajay', 'Ramya', 'Girish', 'Sahana', 'Prakash', 'Bhavana'];
const LAST = ['Kumar', 'Sharma', 'Reddy', 'Nair', 'Patel', 'Gowda', 'Rao', 'Menon', 'Shetty', 'Iyer',
  'Desai', 'Pillai', 'Joshi', 'Bhat', 'Naidu'];
const COLLEGES = ['RV College of Engineering', 'PES University', 'Christ University', 'BMS College',
  'Mount Carmel College', 'MS Ramaiah Institute', 'Jain University'];
const CITIES = ['Bengaluru', 'Mysuru', 'Hubli', 'Mangaluru', 'Chennai', 'Hyderabad'];
const SOURCES = ['Walk-in', 'Website', 'Referral', 'Instagram', 'LinkedIn', 'Google Ads', 'College Drive'];
const QUALS = ['B.E / B.Tech', 'B.Sc', 'BCA', 'MCA', 'B.Com', 'M.Tech', 'MBA'];

function seedDemo() {
  const now = nowIso();

  // ---- staff
  const staffIds = STAFF.map(([name, email, phone, designation, spec]) => db.run(
    `INSERT INTO staff (name, email, phone, designation, specialization, join_date, active, created_at)
     VALUES (?,?,?,?,?,?,1,?)`,
    [name, email, phone, designation, spec, addDays(today(), -int(200, 900)), now],
  ).lastInsertRowid);
  const trainers = staffIds.filter((_, i) => STAFF[i][3] === 'Trainer');
  const counsellor = staffIds[2];

  // ---- courses, syllabus, fee plans
  const courseIds = [];
  COURSES.forEach(([code, name, category, weeks, hours, fee, modules]) => {
    const cid = db.run(
      `INSERT INTO courses (code, name, category, mode, duration_weeks, total_hours, base_fee,
                            tax_percent, description, active, created_at)
       VALUES (?,?,?,?,?,?,?,0,?,1,?)`,
      [code, name, category, pick(['Offline', 'Online', 'Hybrid']), weeks, hours, fee,
        `${name} — ${weeks} weeks, ${hours} hours of instructor-led training with a capstone project.`, now],
    ).lastInsertRowid;
    courseIds.push(cid);

    modules.forEach((title, i) => db.run(
      'INSERT INTO course_modules (course_id, sequence, title, hours, outline) VALUES (?,?,?,?,?)',
      [cid, i + 1, title, Math.round(hours / modules.length), ''],
    ));

    // Two plans per course: pay-in-full (5% off) and a 3-instalment schedule.
    const fullId = db.run(
      `INSERT INTO fee_plans (course_id, name, total_fee, tax_percent, active, notes, created_at)
       VALUES (?,?,?,0,1,?,?)`,
      [cid, 'Pay in full (5% off)', money(fee * 0.95), 'Single payment at admission', now],
    ).lastInsertRowid;
    db.run(
      'INSERT INTO fee_plan_items (fee_plan_id, sequence, label, amount, due_offset_days) VALUES (?,?,?,?,?)',
      [fullId, 1, 'Full payment', money(fee * 0.95), 0],
    );

    const emiId = db.run(
      `INSERT INTO fee_plans (course_id, name, total_fee, tax_percent, active, notes, created_at)
       VALUES (?,?,?,0,1,?,?)`,
      [cid, '3 instalments', fee, 'Registration at admission, then two monthly instalments', now],
    ).lastInsertRowid;
    const part = money(fee / 3);
    [['Registration', part, 0], ['Instalment 2', part, 30], ['Instalment 3', money(fee - part * 2), 60]]
      .forEach(([label, amount, offset], i) => db.run(
        'INSERT INTO fee_plan_items (fee_plan_id, sequence, label, amount, due_offset_days) VALUES (?,?,?,?,?)',
        [emiId, i + 1, label, amount, offset],
      ));
  });

  // ---- batches
  const batchIds = [];
  courseIds.forEach((cid, i) => {
    const course = db.get('SELECT * FROM courses WHERE id = ?', [cid]);
    const specs = [
      { suffix: 'A', offset: -int(60, 120), status: 'Ongoing' },
      { suffix: 'B', offset: -int(10, 40), status: 'Ongoing' },
      { suffix: 'C', offset: int(10, 45), status: 'Planned' },
    ].slice(0, i < 3 ? 3 : 2);

    specs.forEach((sp) => {
      const start = addDays(today(), sp.offset);
      batchIds.push(db.run(
        `INSERT INTO batches (code, course_id, trainer_id, mode, start_date, end_date, days,
                              time_slot, room, capacity, status, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          `${course.code}-${new Date(start).getFullYear()}${sp.suffix}`, cid, pick(trainers),
          course.mode, start, addDays(start, course.duration_weeks * 7),
          pick(['Mon,Wed,Fri', 'Tue,Thu,Sat', 'Sat,Sun']),
          pick(['07:00 - 09:00', '10:00 - 12:00', '15:00 - 17:00', '18:30 - 20:30']),
          pick(['Lab 1', 'Lab 2', 'Seminar Hall', 'Online']),
          int(15, 30), sp.status, '', now,
        ],
      ).lastInsertRowid);
    });
  });

  // ---- students, enrollments, instalments, payments, attendance
  // no 'Admitted' or 'Documents Pending' — those stages are retired
  const STAGES = ['Training', 'Training', 'Training', 'Training', 'Project', 'Certification',
    'Placement Ready', 'Placed', 'Completed'];
  let receiptSeq = 0;

  for (let n = 0; n < 46; n++) {
    const name = `${FIRST[n % FIRST.length]} ${pick(LAST)}`;
    const joined = addDays(today(), -int(5, 300));
    // the first few are registered but not yet enrolled — see the skip below
    const stage = n === 45 ? 'Dropped' : pick(STAGES);
    const status = stage === 'Dropped' ? 'Dropped' : stage === 'Completed' ? 'Completed' : 'Active';
    const regNo = `DA-${new Date(joined).getFullYear()}-${String(n + 1).padStart(4, '0')}`;

    const sid = db.run(
      `INSERT INTO students (reg_no, name, email, phone, dob, gender, address, city, state, pincode,
                             qualification, college, passout_year, guardian_name, guardian_phone,
                             source, status, stage, joined_on, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        regNo, name,
        `${name.split(' ')[0].toLowerCase()}${int(10, 99)}@example.com`,
        `9${int(100000000, 999999999)}`,
        addDays(today(), -int(7000, 11000)), pick(['Male', 'Female']),
        `${int(1, 99)}, ${pick(['MG Road', 'Jayanagar', 'Whitefield', 'Indiranagar', 'Rajajinagar'])}`,
        pick(CITIES), 'Karnataka', String(int(560001, 560100)),
        pick(QUALS), pick(COLLEGES), String(int(2018, 2025)),
        `${pick(FIRST)} ${pick(LAST)}`, `9${int(100000000, 999999999)}`,
        pick(SOURCES), status, stage, joined, '', now, now,
      ],
    ).lastInsertRowid;

    db.run(
      `INSERT INTO stage_history (student_id, from_stage, to_stage, note, changed_by, changed_at)
       VALUES (?,?,?,?,?,?)`,
      [sid, null, C.FIRST_STAGE, 'Student registered', 'system', now],
    );
    if (stage !== C.FIRST_STAGE) {
      db.run(
        `INSERT INTO stage_history (student_id, from_stage, to_stage, note, changed_by, changed_at)
         VALUES (?,?,?,?,?,?)`,
        [sid, C.FIRST_STAGE, stage, 'Progressed during training', 'system', now],
      );
    }

    if (n < 3) continue; // registered but not yet enrolled

    // enrollment
    const batchId = pick(batchIds);
    const batch = db.get('SELECT * FROM batches WHERE id = ?', [batchId]);
    const course = db.get('SELECT * FROM courses WHERE id = ?', [batch.course_id]);
    const plan = db.get(
      'SELECT * FROM fee_plans WHERE course_id = ? ORDER BY id LIMIT 1 OFFSET ?',
      [course.id, rnd() < 0.4 ? 0 : 1],
    );
    const gross = plan.total_fee;
    const discount = rnd() < 0.25 ? money(gross * pick([0.05, 0.1])) : 0;
    const net = money(gross - discount);

    const eid = db.run(
      `INSERT INTO enrollments (student_id, course_id, batch_id, fee_plan_id, gross_fee, discount,
                                discount_note, tax_percent, tax_amount, net_fee, status,
                                enrolled_on, remarks, created_at)
       VALUES (?,?,?,?,?,?,?,0,0,?,?,?,?,?)`,
      [
        sid, course.id, batchId, plan.id, gross, discount,
        discount ? 'Early-bird concession' : '', net,
        status === 'Dropped' ? 'Dropped' : status === 'Completed' ? 'Completed' : 'Active',
        joined, '', now,
      ],
    ).lastInsertRowid;

    // instalments from the plan, scaled to net
    const items = db.all('SELECT * FROM fee_plan_items WHERE fee_plan_id = ? ORDER BY sequence', [plan.id]);
    const planTotal = items.reduce((s, i) => s + i.amount, 0) || 1;
    let running = 0;
    const instIds = [];
    items.forEach((it, idx) => {
      const amount = idx === items.length - 1 ? money(net - running) : money((it.amount / planTotal) * net);
      running = money(running + amount);
      instIds.push({
        id: db.run(
          `INSERT INTO installments (enrollment_id, sequence, label, amount, paid_amount, due_date, status)
           VALUES (?,?,?,?,0,?,'Pending')`,
          [eid, it.sequence, it.label, amount, addDays(joined, it.due_offset_days)],
        ).lastInsertRowid,
        amount,
      });
    });

    // payments — most students have paid at least the first instalment
    const payWhat = status === 'Dropped' ? 1
      : ['Completed', 'Placed'].includes(stage) ? instIds.length
        : int(1, instIds.length);

    for (let k = 0; k < payWhat; k++) {
      const inst = instIds[k];
      // occasionally leave one part-paid
      const amount = (k === payWhat - 1 && rnd() < 0.18) ? money(inst.amount * 0.5) : inst.amount;
      receiptSeq++;
      const paidOn = addDays(joined, k * 30 + int(0, 4));
      if (paidOn > today()) break;

      const pid = db.run(
        `INSERT INTO payments (receipt_no, enrollment_id, student_id, amount, mode, reference,
                               paid_on, collected_by, remarks, voided, created_at)
         VALUES (?,?,?,?,?,?,?,?,'',0,?)`,
        [
          `RCPT-${new Date(paidOn).getFullYear()}-${String(receiptSeq).padStart(6, '0')}`,
          eid, sid, amount, pick(['Cash', 'UPI', 'Card', 'Bank Transfer']),
          `TXN${int(100000, 999999)}`, paidOn, pick(['Vikram Shetty', 'Divya Menon']), now,
        ],
      ).lastInsertRowid;
      db.run('INSERT INTO payment_allocations (payment_id, installment_id, amount) VALUES (?,?,?)',
        [pid, inst.id, amount]);
      db.run(
        `UPDATE installments SET paid_amount = ?, status = ? WHERE id = ?`,
        [amount, amount + 0.01 >= inst.amount ? 'Paid' : 'Partial', inst.id],
      );
    }

    // attendance for ongoing batches
    if (batch.status === 'Ongoing' && ['Training', 'Project'].includes(stage)) {
      for (let s = 0; s < 12; s++) {
        const d = addDays(batch.start_date, s * 2);
        if (d > today()) break;
        const roll = rnd();
        db.run(
          `INSERT OR IGNORE INTO attendance (batch_id, student_id, session_date, status, remark, marked_by, marked_at)
           VALUES (?,?,?,?,'',?,?)`,
          [batchId, sid, d,
            roll < 0.9 ? 'Present' : roll < 0.97 ? 'Absent' : 'Excused',
            'system', now],
        );
      }
    }

    // placements for the far end of the funnel
    if (['Placed', 'Placement Ready', 'Completed'].includes(stage)) {
      const placedNow = stage === 'Placed';
      const applied = addDays(today(), -int(10, 90));
      db.run(
        `INSERT INTO placements (student_id, company, role, package_lpa, location, applied_on,
                                 interview_on, offer_date, joined_on, status, remarks, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'',?)`,
        [
          sid,
          pick(['Infosys', 'TCS', 'Wipro', 'Mu Sigma', 'Fractal Analytics', 'Accenture', 'Deloitte', 'ZS Associates']),
          pick(['Data Analyst', 'Business Analyst', 'Data Engineer', 'BI Developer', 'ML Engineer']),
          money(int(35, 120) / 10), pick(CITIES), applied, addDays(applied, 7),
          placedNow ? addDays(applied, 14) : null,
          placedNow ? addDays(applied, 30) : null,
          placedNow ? 'Joined' : pick(['Applied', 'Interview', 'Rejected']), now,
        ],
      );
    }
  }

  // ---- enquiries + follow-ups
  for (let n = 0; n < 26; n++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const created = addDays(today(), -int(0, 70));
    const status = pick(['New', 'New', 'Contacted', 'Contacted', 'Interested', 'Negotiating', 'Lost']);
    const eid = db.run(
      `INSERT INTO enquiries (name, email, phone, city, course_id, source, assigned_to, status,
                              priority, next_followup, lost_reason, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name, `${name.split(' ')[0].toLowerCase()}${int(10, 99)}@example.com`,
        `9${int(100000000, 999999999)}`, pick(CITIES), pick(courseIds), pick(SOURCES),
        counsellor, status, pick(['High', 'Medium', 'Medium', 'Low']),
        status === 'Lost' ? null : addDays(today(), int(-6, 12)),
        status === 'Lost' ? pick(['Fee too high', 'Joined elsewhere', 'Not reachable', 'Postponed']) : null,
        '', created, created,
      ],
    ).lastInsertRowid;

    if (status !== 'New') {
      db.run(
        `INSERT INTO followups (enquiry_id, done_on, channel, remark, outcome, next_date, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          eid, addDays(created, int(1, 5)), pick(['Call', 'WhatsApp', 'Visit']),
          pick(['Explained the syllabus and fee structure.',
            'Shared the brochure and demo class link.',
            'Discussed the instalment options.',
            'Parent wanted to visit the campus first.']),
          pick(['Interested', 'Will decide after the demo', 'Asked for a discount']),
          addDays(today(), int(1, 10)), 'system', nowIso(),
        ],
      );
    }
  }

  // ---- expenses
  const CATS = [['Rent', 45000], ['Salary', 210000], ['Marketing', 32000],
    ['Utilities', 9000], ['Software', 12000], ['Misc', 6000]];
  for (let m = 5; m >= 0; m--) {
    const d = addDays(today(), -m * 30);
    for (const [category, base] of CATS) {
      db.run(
        `INSERT INTO expenses (spent_on, category, amount, mode, vendor, reference, remarks, created_at)
         VALUES (?,?,?,?,?,?,'',?)`,
        [d, category, money(base * (0.85 + rnd() * 0.3)), 'Bank Transfer',
          pick(['Prime Estates', 'Payroll', 'AdWorks', 'BESCOM', 'SaaS Vendor', 'Sundry']),
          `INV${int(1000, 9999)}`, nowIso()],
      );
    }
  }

  // ---- tasks
  [
    ['Call the overdue-fee list', 'Ring every student with a payment past its due date.', 0, 'High'],
    ['Confirm trainer for the next DS-201 batch', '', 3, 'Medium'],
    ['Upload pending Aadhaar documents', 'Six students still have documents pending.', 2, 'Medium'],
    ['Prepare the monthly placement report', '', 7, 'Low'],
    ['Follow up with Infosys HR on the drive', '', 1, 'High'],
  ].forEach(([title, detail, inDays, priority]) => db.run(
    `INSERT INTO tasks (title, detail, due_date, priority, status, owner, created_at)
     VALUES (?,?,?,?,'Open','Dhishaai Admin',?)`,
    [title, detail, addDays(today(), inDays), priority, nowIso()],
  ));

  settings.set('demo_seeded', '1');
  console.log('  Demo data loaded — 46 students, 26 enquiries, 6 courses, 16 batches.');
  console.log('  Remove it any time from Settings → Data → Clear demo data.\n');
}

/** Called on every boot; does nothing once the database has content. */
function ensureSeeded() {
  const users = db.scalar('SELECT COUNT(*) c FROM users');
  if (users === 0) createOwner();

  const students = db.scalar('SELECT COUNT(*) c FROM students');
  const seeded = settings.get('demo_seeded', '0');
  if (students === 0 && seeded !== '1' && process.env.DHISHAAI_NO_DEMO !== '1') {
    db.tx(seedDemo);
  }
}

module.exports = { ensureSeeded, seedDemo, createOwner, DEFAULT_ADMIN };

// -------------------------------------------------------------- CLI
if (require.main === module) {
  migrate();
  if (process.argv.includes('--reset')) {
    console.log('Resetting transactional data…');
    db.tx(() => {
      for (const t of [
        'payment_allocations', 'payments', 'installments', 'enrollments', 'attendance',
        'placements', 'stage_history', 'student_documents', 'students', 'followups',
        'enquiries', 'expenses', 'tasks', 'fee_plan_items', 'fee_plans',
        'course_modules', 'batches', 'courses', 'staff',
      ]) db.run(`DELETE FROM ${t}`);
      settings.set('demo_seeded', '0');
    });
  }
  ensureSeeded();
  console.log('Done.');
  db.close();
}
