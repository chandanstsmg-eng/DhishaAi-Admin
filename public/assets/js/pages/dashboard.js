import { api } from '../api.js';
import { h, fmt, card, pageHead, statTile, dataTable, badge, progressBar } from '../ui.js';
import { barChart, rankedBars } from '../charts.js';
import { navigate } from '../router.js';

export default async function dashboard() {
  const d = await api.get('/api/dashboard');
  const k = d.kpis;

  // -------------------------------------------------------- tiles
  const tiles = h('div', { class: 'tiles' },
    statTile({
      label: 'Collected this month', value: fmt.money(k.collected_month), tone: 'accent',
      sub: `${fmt.money(k.collected_today)} today`,
      onClick: () => navigate('/payments'),
    }),
    statTile({
      label: 'Outstanding', value: fmt.money(k.outstanding_total),
      tone: k.overdue_amount > 0 ? 'danger' : '',
      sub: k.overdue_amount > 0
        ? `${fmt.money(k.overdue_amount)} overdue · ${k.overdue_count} student(s)`
        : 'Nothing overdue',
      onClick: () => navigate('/fees'),
    }),
    statTile({
      label: 'Active students', value: fmt.num(k.students_active), tone: 'good',
      sub: `${k.students_new_month} joined this month · ${fmt.num(k.students_total)} total`,
      onClick: () => navigate('/students?status=Active'),
    }),
    statTile({
      label: 'Open enquiries', value: fmt.num(k.enquiries_open),
      tone: k.enquiries_due > 0 ? 'warn' : '',
      sub: k.enquiries_due > 0 ? `${k.enquiries_due} follow-up(s) due` : 'All follow-ups on track',
      onClick: () => navigate('/enquiries?open=1'),
    }),
    statTile({
      label: 'Ongoing batches', value: fmt.num(k.batches_ongoing),
      sub: `${k.courses_active} active course(s)`,
      onClick: () => navigate('/batches?status=Ongoing'),
    }),
    statTile({
      label: 'Net this month', value: fmt.money(k.net_month),
      tone: k.net_month >= 0 ? 'good' : 'danger',
      sub: `${fmt.money(k.expenses_month)} spent`,
      onClick: () => navigate('/reports/profit_loss'),
    }));

  // ------------------------------------------------------- charts
  /*
   * Every card on this screen is a summary of somewhere else, so every card
   * says where that is. The chart cards point at the report built on the same
   * figures rather than at a list, so following the link widens the same
   * question instead of changing it.
   */
  const trendCard = card('Collections vs expenses', barChart({
    rows: d.trend,
    xKey: 'month',
    series: [{ key: 'collected', label: 'Collected' }, { key: 'expenses', label: 'Expenses' }],
    xFormat: fmt.month,
    valueFormat: fmt.moneyShort,
    height: 240,
  }), {
    sub: 'Last 12 months',
    right: h('a', { href: '#/reports/collections_monthly', class: 'small' }, 'Collections report →'),
  });

  const admissionsCard = card('Admissions', barChart({
    rows: d.trend,
    xKey: 'month',
    series: [{ key: 'admissions', label: 'New students' }],
    xFormat: fmt.month,
    valueFormat: fmt.num,
    height: 240,
  }), {
    sub: 'New students joined per month',
    right: h('a', { href: '#/reports/admissions', class: 'small' }, 'Admissions report →'),
  });

  const stageCard = card('Students by stage', rankedBars({
    rows: d.by_stage.map((r) => ({ label: r.stage, value: r.c })),
    valueFormat: fmt.num,
    limit: 12,
  }), {
    sub: 'Where everyone sits in the lifecycle',
    right: h('a', { href: '#/pipeline', class: 'small' }, 'Open board →'),
  });

  const courseCard = card('Top courses by collection', rankedBars({
    rows: d.by_course.map((r) => ({
      label: r.name, value: r.collected, sub: `${r.students} student(s)`,
    })),
    valueFormat: fmt.moneyShort,
    colorIndex: 1,
    limit: 8,
  }), {
    sub: 'Money actually received',
    right: h('a', { href: '#/reports/course_revenue', class: 'small' }, 'Revenue by course →'),
  });

  // --------------------------------------------------- work queues
  const dueCard = card('Fees due & overdue', dataTable({
    columns: [
      { key: 'student_name', label: 'Student', render: (r) => h('div', {},
        h('div', { class: 'strong' }, r.student_name),
        h('div', { class: 'small muted' }, `${r.reg_no} · ${r.course_name}`)) },
      { key: 'label', label: 'Instalment', render: (r) => h('div', {},
        h('div', {}, r.label),
        h('div', { class: 'small muted' }, fmt.date(r.due_date))) },
      { key: 'balance', label: 'Balance', align: 'right', render: (r) => h('div', {},
        h('div', { class: 'strong' }, fmt.money(r.balance)),
        r.days_overdue > 0
          ? badge(`${r.days_overdue}d late`, 'danger')
          : badge('Due soon', 'warn')) },
    ],
    rows: d.due_soon,
    onRow: (r) => navigate(`/students/${r.student_id}`),
    empty: 'No fees due in the next few days',
    emptyHint: 'Collections are fully up to date.',
  }), {
    flush: true,
    sub: `${d.due_soon.length} instalment(s) need attention`,
    right: h('a', { href: '#/fees', class: 'small' }, 'All dues →'),
  });

  const followCard = card('Follow-ups due', dataTable({
    columns: [
      { key: 'name', label: 'Lead', render: (r) => h('div', {},
        h('div', { class: 'strong' }, r.name),
        h('div', { class: 'small muted' }, `${r.phone}${r.course_name ? ` · ${r.course_name}` : ''}`)) },
      { key: 'priority', label: 'Priority', render: (r) => badge(r.priority) },
      { key: 'next_followup', label: 'Due', align: 'right', render: (r) => h('div', {},
        h('div', { class: 'small' }, fmt.dateShort(r.next_followup)),
        r.days_late > 0 ? badge(`${r.days_late}d late`, 'danger') : badge('Today', 'warn')) },
    ],
    rows: d.followups_due,
    onRow: (r) => navigate(`/enquiries/${r.id}`),
    empty: 'No follow-ups pending',
    emptyHint: 'Every lead has been contacted on schedule.',
  }), {
    flush: true,
    sub: `${d.followups_due.length} lead(s) waiting`,
    right: h('a', { href: '#/enquiries?due=1', class: 'small' }, 'All leads →'),
  });

  const batchCard = card('Batches starting soon', dataTable({
    columns: [
      { key: 'code', label: 'Batch', render: (r) => h('div', {},
        h('div', { class: 'strong' }, r.code),
        h('div', { class: 'small muted' }, r.course_name)) },
      { key: 'start_date', label: 'Starts', render: (r) => h('div', {},
        h('div', {}, fmt.dateShort(r.start_date)),
        h('div', { class: 'small muted' }, r.time_slot || '—')) },
      { key: 'filled', label: 'Seats', align: 'right', render: (r) => h('div', {},
        h('div', { class: 'small mono' }, `${r.filled}/${r.capacity}`),
        progressBar((r.filled / Math.max(1, r.capacity)) * 100)) },
    ],
    rows: d.starting_soon,
    onRow: (r) => navigate(`/batches/${r.id}`),
    empty: 'No batches scheduled ahead',
    emptyHint: 'Plan the next intake from the Batches screen.',
  }), { flush: true, right: h('a', { href: '#/batches', class: 'small' }, 'All batches →') });

  const paymentsCard = card('Recent receipts', dataTable({
    columns: [
      { key: 'receipt_no', label: 'Receipt', render: (r) => h('div', {},
        h('div', { class: 'strong mono' }, r.receipt_no),
        h('div', { class: 'small muted' }, `${r.student_name} · ${fmt.dateShort(r.paid_on)}`)) },
      { key: 'mode', label: 'Mode', render: (r) => badge(r.mode, 'navy') },
      { key: 'amount', label: 'Amount', align: 'right', render: (r) => h('span', { class: 'strong' }, fmt.money(r.amount)) },
    ],
    rows: d.recent_payments,
    onRow: (r) => api.openTab(`/api/payments/${r.id}/receipt`),
    empty: 'No payments recorded yet',
  }), { flush: true, right: h('a', { href: '#/payments', class: 'small' }, 'All payments →') });

  const head = pageHead(
    greeting(),
    headSub(k.collection_rate),
    [
      h('button', { class: 'btn primary', onClick: () => navigate('/students') }, '+ Add Student'),
      h('button', { class: 'btn navy', onClick: () => navigate('/enquiries') }, '+ Add Enquiry'),
      h('button', { class: 'btn', onClick: () => navigate('/reports') }, 'Export Report'),
    ],
  );
  keepHeadCurrent(head, k.collection_rate);

  return h('div', {},
    head,
    tiles,
    h('div', { class: 'grid s21', style: { marginBottom: '14px' } }, trendCard, stageCard),
    h('div', { class: 'grid c2', style: { marginBottom: '14px' } }, dueCard, followCard),
    h('div', { class: 'grid s21', style: { marginBottom: '14px' } }, admissionsCard, courseCard),
    // two cards now the activity feed is gone, so they share the row evenly
    h('div', { class: 'grid c2' }, batchCard, paymentsCard));
}

/**
 * Greeting band, driven by the AM/PM half of the local clock:
 * every AM hour is morning, PM splits at 5 into afternoon and evening.
 */
function greeting(hour = new Date().getHours()) {
  if (hour < 12) return 'Good morning';    // 12:00 am – 11:59 am
  if (hour < 17) return 'Good afternoon';  // 12:00 pm –  4:59 pm
  return 'Good evening';                   //  5:00 pm – 11:59 pm
}

const headSub = (rate, now = new Date()) =>
  `${fmt.date(now)} · ${fmt.time(now)} · ${rate}% of billed fees collected overall`;

/**
 * The dashboard is the screen most likely to sit open all day, so the greeting,
 * date and clock are repainted rather than frozen at page load. The timer stops
 * itself once the header is no longer on screen — the router has no teardown hook.
 */
function keepHeadCurrent(head, rate) {
  const title = head.querySelector('h1');
  const sub = head.querySelector('.sub');
  const id = setInterval(() => {
    if (!document.body.contains(head)) { clearInterval(id); return; }
    const now = new Date();
    title.textContent = greeting(now.getHours());
    sub.textContent = headSub(rate, now);
  }, 30000);
}
