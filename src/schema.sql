-- =====================================================================
-- Dhishaai Admin Portal :: relational schema
-- SQLite. All money columns are REAL rupees rounded to 2 decimals.
-- All *_at / *_date columns are ISO strings (YYYY-MM-DD or full ISO).
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- core
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',   -- owner | admin | counsellor | accounts | staff
  active        INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT,
  action     TEXT NOT NULL,        -- create | update | delete | login | logout | payment | stage
  entity     TEXT NOT NULL,        -- students | payments | ...
  entity_id  TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity, entity_id);

-- ------------------------------------------------------------- academic
CREATE TABLE IF NOT EXISTS courses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT,                       -- Data Science | Analytics | Programming | ...
  mode           TEXT DEFAULT 'Offline',     -- Offline | Online | Hybrid
  duration_weeks INTEGER DEFAULT 0,
  total_hours    INTEGER DEFAULT 0,
  base_fee       REAL NOT NULL DEFAULT 0,
  tax_percent    REAL NOT NULL DEFAULT 0,
  description    TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS course_modules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sequence  INTEGER NOT NULL DEFAULT 1,
  title     TEXT NOT NULL,
  hours     INTEGER DEFAULT 0,
  outline   TEXT
);
CREATE INDEX IF NOT EXISTS idx_modules_course ON course_modules(course_id, sequence);

CREATE TABLE IF NOT EXISTS staff (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  designation    TEXT,                        -- Trainer | Counsellor | Accounts | Placement
  specialization TEXT,
  join_date      TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  trainer_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  mode       TEXT DEFAULT 'Offline',
  start_date TEXT,
  end_date   TEXT,
  days       TEXT,                             -- "Mon,Wed,Fri"
  time_slot  TEXT,                             -- "10:00 - 12:00"
  room       TEXT,
  capacity   INTEGER DEFAULT 30,
  status     TEXT NOT NULL DEFAULT 'Planned',  -- Planned | Ongoing | Completed | Cancelled
  notes      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_course ON batches(course_id);

-- -------------------------------------------------------------- funnel
CREATE TABLE IF NOT EXISTS enquiries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  email          TEXT,
  phone          TEXT NOT NULL,
  city           TEXT,
  course_id      INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  course_other   TEXT,                          -- what they asked for when it is not a course we list
  source         TEXT,                          -- Walk-in | Website | Referral | Instagram | ...
  assigned_to    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'New',   -- New | Contacted | Interested | Negotiating | Converted | Lost
  priority       TEXT NOT NULL DEFAULT 'Medium',-- High | Medium | Low
  next_followup  TEXT,
  demo_on        TEXT,                          -- date a demo class is booked for this lead
  joined_on      TEXT,                          -- admission date, once the lead joins
  lost_reason    TEXT,
  notes          TEXT,
  student_id     INTEGER REFERENCES students(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_enq_status ON enquiries(status);
CREATE INDEX IF NOT EXISTS idx_enq_follow ON enquiries(next_followup);

CREATE TABLE IF NOT EXISTS followups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  done_on    TEXT NOT NULL,
  channel    TEXT,                              -- Call | WhatsApp | Email | Visit
  remark     TEXT,
  outcome    TEXT,
  next_date  TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follow_enq ON followups(enquiry_id, done_on DESC);

-- ------------------------------------------------------------- students
CREATE TABLE IF NOT EXISTS students (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_no         TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  email          TEXT,
  phone          TEXT NOT NULL,
  alt_phone      TEXT,
  dob            TEXT,
  gender         TEXT,
  address        TEXT,
  city           TEXT,
  state          TEXT,
  pincode        TEXT,
  qualification  TEXT,
  college        TEXT,
  passout_year   TEXT,
  experience     TEXT,
  guardian_name  TEXT,
  guardian_phone TEXT,
  source         TEXT,
  status         TEXT NOT NULL DEFAULT 'Active',   -- Active | On Hold | Completed | Dropped
  stage          TEXT NOT NULL DEFAULT 'Training', -- lifecycle pipeline stage
  joined_on      TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_students_stage  ON students(stage);
CREATE INDEX IF NOT EXISTS idx_students_phone  ON students(phone);

CREATE TABLE IF NOT EXISTS student_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL,          -- Aadhaar | PAN | Marksheet | Photo | Resume
  doc_no      TEXT,
  file_name   TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,
  remarks     TEXT,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_student ON student_documents(student_id);

CREATE TABLE IF NOT EXISTS stage_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  note       TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_student ON stage_history(student_id, changed_at DESC);

-- ------------------------------------------------------------------ fees
-- A fee plan is a reusable template attached to a course.
CREATE TABLE IF NOT EXISTS fee_plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                 -- "Full payment", "3 instalments"
  total_fee    REAL NOT NULL DEFAULT 0,
  tax_percent  REAL NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_course ON fee_plans(course_id);

CREATE TABLE IF NOT EXISTS fee_plan_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fee_plan_id     INTEGER NOT NULL REFERENCES fee_plans(id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL DEFAULT 1,
  label           TEXT NOT NULL,              -- "Registration", "Instalment 1"
  amount          REAL NOT NULL DEFAULT 0,
  due_offset_days INTEGER NOT NULL DEFAULT 0  -- days after enrollment date
);
CREATE INDEX IF NOT EXISTS idx_plan_items ON fee_plan_items(fee_plan_id, sequence);

-- --------------------------------------------------------- enrollments
CREATE TABLE IF NOT EXISTS enrollments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id      INTEGER NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  batch_id       INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  fee_plan_id    INTEGER REFERENCES fee_plans(id) ON DELETE SET NULL,
  gross_fee      REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  discount_note  TEXT,
  tax_percent    REAL NOT NULL DEFAULT 0,
  tax_amount     REAL NOT NULL DEFAULT 0,
  net_fee        REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'Active', -- Active | Completed | Dropped | On Hold
  enrolled_on    TEXT NOT NULL,
  completed_on   TEXT,
  certificate_no TEXT,
  remarks        TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enr_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enr_batch   ON enrollments(batch_id);

CREATE TABLE IF NOT EXISTS installments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL DEFAULT 1,
  label         TEXT NOT NULL,
  amount        REAL NOT NULL DEFAULT 0,
  paid_amount   REAL NOT NULL DEFAULT 0,
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'Pending', -- Pending | Partial | Paid | Waived
  waived_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_inst_enr ON installments(enrollment_id, sequence);
CREATE INDEX IF NOT EXISTS idx_inst_due ON installments(due_date, status);

-- --------------------------------------------------------------- money
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no    TEXT NOT NULL UNIQUE,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount        REAL NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'Cash',   -- Cash | UPI | Card | Bank Transfer | Cheque
  reference     TEXT,
  paid_on       TEXT NOT NULL,
  collected_by  TEXT,
  remarks       TEXT,
  voided        INTEGER NOT NULL DEFAULT 0,
  void_reason   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_student ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_pay_date    ON payments(paid_on DESC);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id     INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  installment_id INTEGER NOT NULL REFERENCES installments(id) ON DELETE CASCADE,
  amount         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alloc_pay  ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_alloc_inst ON payment_allocations(installment_id);

CREATE TABLE IF NOT EXISTS expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  spent_on   TEXT NOT NULL,
  category   TEXT NOT NULL,          -- Rent | Salary | Marketing | Utilities | Misc
  amount     REAL NOT NULL,
  mode       TEXT DEFAULT 'Bank Transfer',
  vendor     TEXT,
  reference  TEXT,
  remarks    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(spent_on DESC);

-- ---------------------------------------------------------- attendance
CREATE TABLE IF NOT EXISTS attendance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'Present', -- Present | Absent | Late | Excused
  remark       TEXT,
  marked_by    TEXT,
  marked_at    TEXT NOT NULL,
  UNIQUE(batch_id, student_id, session_date)
);
CREATE INDEX IF NOT EXISTS idx_att_batch ON attendance(batch_id, session_date);

-- ----------------------------------------------------------- placement
CREATE TABLE IF NOT EXISTS placements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  company      TEXT NOT NULL,
  role         TEXT,
  package_lpa  REAL,
  location     TEXT,
  applied_on   TEXT,
  interview_on TEXT,
  offer_date   TEXT,
  joined_on    TEXT,
  status       TEXT NOT NULL DEFAULT 'Applied', -- Applied | Interview | Offered | Joined | Rejected
  remarks      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plc_student ON placements(student_id);
CREATE INDEX IF NOT EXISTS idx_plc_status  ON placements(status);

-- --------------------------------------------------------------- tasks
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  detail     TEXT,
  due_date   TEXT,
  priority   TEXT NOT NULL DEFAULT 'Medium',
  status     TEXT NOT NULL DEFAULT 'Open',   -- Open | Done
  owner      TEXT,
  link_type  TEXT,                            -- students | enquiries
  link_id    INTEGER,
  created_at TEXT NOT NULL,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_date);
