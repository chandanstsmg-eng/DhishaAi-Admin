'use strict';
/** Enumerations shared by the API and served to the browser via /api/meta. */

/*
 * The end-to-end lifecycle a student moves through, in order.
 *
 * "Admitted" and "Documents Pending" are gone — the office does not run the
 * pipeline that way. A student who is on the books is in Training, and chasing
 * paperwork is tracked on the Documents tab of their profile, which knows which
 * proof is missing; a whole pipeline column could only ever say "something is".
 *
 * The two stages are retired, not merely hidden: RETIRED_STAGES below is what
 * moves anyone still standing on them, so nobody falls off the board.
 */
const STUDENT_STAGES = [
  'Training',
  'Project',
  'Certification',
  'Placement Ready',
  'Placed',
  'Completed',
  'Dropped',
];

/** Stages no longer offered, and the stage anyone left on one is moved to. */
const RETIRED_STAGES = ['Admitted', 'Documents Pending'];
const FIRST_STAGE = STUDENT_STAGES[0];

const STUDENT_STATUS = ['Active', 'On Hold', 'Completed', 'Dropped'];
const ENROLLMENT_STATUS = ['Active', 'On Hold', 'Completed', 'Dropped'];
const ENQUIRY_STATUS = ['New', 'Contacted', 'Interested', 'Negotiating', 'Converted', 'Lost'];
const PRIORITY = ['High', 'Medium', 'Low'];
const BATCH_STATUS = ['Planned', 'Ongoing', 'Completed', 'Cancelled'];
const MODES = ['Offline', 'Online', 'Hybrid'];
const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Cheque', 'Netbanking'];
const INSTALLMENT_STATUS = ['Pending', 'Partial', 'Paid', 'Waived'];
/*
 * "Late" is gone — the office does not track it. Marks already stored as
 * 'Late' stay as they are and still count as attended, so no past percentage
 * moves; ATTENDED_SQL is what keeps that true.
 *
 * "No class" records that the session did not run. It is nobody's absence, so
 * it is kept out of the attendance rate on both sides — neither attended nor
 * missed — and reported as a note rather than a column of its own.
 */
const ATTENDANCE_STATUS = ['Present', 'Absent', 'Excused', 'No class'];
const NO_CLASS = 'No class';
/** Attended, including the historic 'Late' marks. */
const ATTENDED_SQL = "IN ('Present','Late')";

/*
 * What an attendance rate is worked out from: the classes that were actually
 * held and that this student was expected at. Present (and historic Late)
 * count as attended, Absent counts against, and the percentage is one over the
 * other — nothing else.
 *
 * Everything else stays out of the sum entirely, denominator included. 'No
 * class' is a session that never ran; 'Excused' is an absence the office
 * approved. Neither is a class the student failed to turn up to, and leaving
 * either in the denominator quietly scores it as one — which is how a row came
 * to read "4 marked, 2 present, 1 absent" and expect anyone to see where the
 * fourth went.
 *
 * Defined here once because the batch summary, the student's own profile and
 * the batch-performance report all read from it. Three copies of this rule
 * would sooner or later be three different percentages for the same student.
 */
const COUNTED_SQL = "IN ('Present','Late','Absent')";
const PLACEMENT_STATUS = ['Applied', 'Interview', 'Offered', 'Joined', 'Rejected'];
const SOURCES = [
  'Walk-in', 'Website', 'Referral', 'Instagram', 'LinkedIn', 'Google Ads',
  'JustDial', 'College Drive', 'Alumni', 'Other',
];
const CHANNELS = ['Call', 'WhatsApp', 'Email', 'Visit', 'SMS'];
// Counsellor and Placement Officer were dropped — the office does not use them
// as separate roles. Anyone already carrying one keeps it: buildForm shows a
// value that has left this list rather than quietly swapping it for another.
const DESIGNATIONS = ['Trainer', 'Accounts', 'Admin', 'Support'];
const EXPENSE_CATEGORIES = [
  'Rent', 'Salary', 'Marketing', 'Utilities', 'Software', 'Equipment', 'Travel', 'Misc',
];
const DOC_TYPES = [
  'Aadhaar', 'PAN', 'Photo', '10th Marksheet', '12th Marksheet',
  'Degree Certificate', 'Resume', 'Offer Letter', 'Other',
];
const ROLES = ['owner', 'admin', 'accounts', 'counsellor', 'staff'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * "Who is owed a call right now" — the one definition behind the Enquiries and
 * Follow-ups badges and the Follow-ups screen itself. Kept here so the number
 * on the badge and the number of rows on the screen cannot drift apart.
 *
 * A lead owes a call when the promised date has arrived or passed, or when no
 * call was ever scheduled. Converted and Lost leads are finished with.
 */
const callsOwedWhere = (t = 'e') => `
  ${t}.status NOT IN ('Converted','Lost')
  AND (${t}.next_followup IS NULL OR date(${t}.next_followup) <= date('now'))`;
const CALLS_OWED_SQL = `SELECT COUNT(*) c FROM enquiries e WHERE ${callsOwedWhere('e')}`;

module.exports = {
  STUDENT_STAGES, RETIRED_STAGES, FIRST_STAGE,
  STUDENT_STATUS, ENROLLMENT_STATUS, ENQUIRY_STATUS, PRIORITY,
  BATCH_STATUS, MODES, PAYMENT_MODES, INSTALLMENT_STATUS, ATTENDANCE_STATUS,
  PLACEMENT_STATUS, SOURCES, CHANNELS, DESIGNATIONS, EXPENSE_CATEGORIES,
  DOC_TYPES, ROLES, DAYS, ATTENDED_SQL, COUNTED_SQL, NO_CLASS,
  callsOwedWhere, CALLS_OWED_SQL,
};
