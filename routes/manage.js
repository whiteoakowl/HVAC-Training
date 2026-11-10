// Management portal: business dashboard, employees, timesheets, reports.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const accounting = require('../utils/accounting');
const inventory = require('../utils/inventory');
const jobs = require('../utils/jobs');
const timeclock = require('../utils/timeclock');
const notifications = require('../utils/notifications');
const settings = require('../utils/settings');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action, asArray } = require('../utils/http');

router.use(requireAuth);

async function scalar(sql, ...params) {
  const row = await db.prepare(sql).get(...params);
  return row ? Number(Object.values(row)[0] || 0) : 0;
}

// ---------------------------------------------------------------- dashboard
router.get('/', requirePermission('portal.management'), async (req, res) => {
  const today = fmt.today();
  const monthStart = today.slice(0, 8) + '01';
  const yearStart = today.slice(0, 5) + '01-01';
  const weekStart = fmt.weekStart(today);
  const in7 = fmt.addDays(today, 7);
  const m = {};
  if (req.can('accounting.view')) {
    const [month, year, all] = await Promise.all([accounting.profitAndLoss(monthStart, today), accounting.profitAndLoss(yearStart, today), accounting.profitAndLoss('1900-01-01', today)]);
    const bal = await accounting.balances({ to: today });
    const code = (c) => (bal.find((r) => r.code === c) || { balance: 0 }).balance;
    Object.assign(m, {
      revenueMonth: month.income, revenueYear: year.income, revenueAll: all.income, netMonth: month.netIncome, netYear: year.netIncome,
      expensesMonth: month.expense, payrollMonth: (month.rows.find((r) => r.code === '6000') || { balance: 0 }).balance, cogsMonth: month.cogs,
      cash: code('1000'), arLedger: code('1100'), ap: code('2000'),
      agreementRevenueYear: (year.rows.find((r) => r.code === '4200') || { balance: 0 }).balance,
    });
  }
  if (req.can('invoices.view', 'invoices.manage', 'accounting.view')) {
    m.openInvoices = await scalar("SELECT COUNT(*) FROM invoices WHERE status IN ('issued','partial')");
    m.arOpen = await scalar("SELECT COALESCE(SUM(total_cents - amount_paid_cents - credited_cents), 0) FROM invoices WHERE status IN ('issued','partial')");
    m.overdue = await scalar("SELECT COUNT(*) FROM invoices WHERE status IN ('issued','partial') AND due_date < ?", today);
    m.drafts = await scalar("SELECT COUNT(*) FROM invoices WHERE status = 'draft'");
  }
  const closed = jobs.CLOSED.map((s) => `'${s}'`).join(',');
  m.activeJobs = await scalar(`SELECT COUNT(*) FROM jobs WHERE status NOT IN (${closed})`);
  m.completedMonth = await scalar("SELECT COUNT(*) FROM jobs WHERE completed_at >= ?", monthStart + ' 00:00:00');
  m.pendingEstimates = (await scalar("SELECT COUNT(*) FROM estimates WHERE status = 'sent'")) + (await scalar("SELECT COUNT(*) FROM jobs WHERE status IN ('estimate_requested','estimate_scheduled','estimate_sent','awaiting_approval')"));
  m.pendingEstimateValue = await scalar("SELECT COALESCE(SUM(total_cents), 0) FROM estimates WHERE status = 'sent'");
  m.approvedEstimates = await scalar("SELECT COUNT(*) FROM jobs WHERE status IN ('approved','ready_to_schedule')");
  m.activeAgreements = await scalar("SELECT COUNT(*) FROM maintenance_agreements WHERE status = 'active'");
  m.scheduled7 = await scalar(`SELECT COUNT(*) FROM jobs WHERE scheduled_start >= ? AND scheduled_start < ? AND status NOT IN (${closed})`, today + ' 00:00:00', in7 + ' 00:00:00');
  m.waitingParts = await scalar("SELECT COUNT(*) FROM jobs WHERE status = 'waiting_on_parts'");
  m.openRequests = await scalar("SELECT COUNT(*) FROM service_requests WHERE status IN ('new','contacted')");
  m.newCustomersMonth = await scalar('SELECT COUNT(*) FROM customers WHERE created_at >= ?', monthStart + ' 00:00:00');
  m.customers = await scalar('SELECT COUNT(*) FROM customers WHERE active = 1');
  if (req.can('inventory.view', 'inventory.manage')) {
    const values = await inventory.valueByLocation();
    m.inventoryValue = values.reduce((s, v) => s + v.value, 0);
    m.truckValue = values.filter((v) => v.kind === 'truck').reduce((s, v) => s + v.value, 0);
    m.lowStock = (await inventory.lowStock()).length;
    m.pendingParts = await scalar("SELECT COUNT(*) FROM parts_requests WHERE status = 'pending'");
  }
  if (req.can('timesheets.approve', 'employees.view')) {
    const entries = await timeclock.entries({ from: weekStart + ' 00:00:00', to: fmt.addDays(weekStart, 7) + ' 00:00:00' });
    const valid = entries.filter((e) => e.status !== 'rejected');
    m.hoursWeek = valid.reduce((s, e) => s + e.workedMinutes, 0);
    m.jobHoursWeek = valid.filter((e) => e.job_id).reduce((s, e) => s + e.workedMinutes, 0);
    m.clockedIn = entries.filter((e) => e.status === 'open').length;
    m.pendingTime = await scalar("SELECT COUNT(*) FROM time_entries WHERE status = 'pending'");
  }
  const upcoming = await jobs.list({ from: today + ' 00:00:00', to: in7 + ' 23:59:59', open: true, limit: 15 });
  const maintenance = await jobs.list({ from: today + ' 00:00:00', to: fmt.addDays(today, 30) + ' 23:59:59', open: true, limit: 200 });
  const certs = req.can('employees.view')
    ? await db.prepare('SELECT c.*, m.name AS "memberName" FROM certifications c JOIN members m ON m.id = c.member_id WHERE m.active = 1 AND c.expires_on IS NOT NULL AND c.expires_on <= ? ORDER BY c.expires_on').all(fmt.addDays(today, 60))
    : [];
  res.render('manage-dashboard', { title: 'Business Dashboard', m, upcoming, maintenance: maintenance.filter((j) => j.job_type === 'maintenance'), certs, today, monthStart, yearStart });
});

// ---------------------------------------------------------------- employees
router.get('/employees', requirePermission('employees.view'), async (req, res) => {
  const rows = await db
    .prepare(`SELECT m.id, m.name, m.email, m.phone, m.role, m.active, r.name AS "roleName", ep.employee_number, ep.job_title, ep.hire_date, t.name AS "truckName",
        (SELECT COUNT(*) FROM certifications c WHERE c.member_id = m.id AND c.expires_on IS NOT NULL AND c.expires_on < ?) AS "expiredCerts"
      FROM members m LEFT JOIN roles r ON r.key = m.role LEFT JOIN employee_profiles ep ON ep.member_id = m.id LEFT JOIN trucks t ON t.assigned_member_id = m.id AND t.active = 1
      WHERE m.role NOT IN ('customer', 'student') ORDER BY m.active DESC, m.name`)
    .all(fmt.today());
  res.render('manage-employees', { title: 'Employees', rows });
});

router.get('/employees/:id', requirePermission('employees.view'), async (req, res) => {
  const emp = await db.prepare('SELECT m.*, r.name AS "roleName" FROM members m LEFT JOIN roles r ON r.key = m.role WHERE m.id = ?').get(req.params.id);
  if (!emp) return res.status(404).render('404', { title: 'Not Found' });
  const [profile, certs, trainingRows, week, truck, openJobs] = await Promise.all([
    db.prepare('SELECT * FROM employee_profiles WHERE member_id = ?').get(emp.id),
    db.prepare('SELECT * FROM certifications WHERE member_id = ? ORDER BY expires_on').all(emp.id),
    db.prepare("SELECT ta.*, t.title FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id WHERE ta.member_id = ? ORDER BY ta.assigned_at DESC").all(emp.id),
    timeclock.weekSummary(emp.id, fmt.today()),
    db.prepare('SELECT * FROM trucks WHERE assigned_member_id = ? AND active = 1').get(emp.id),
    jobs.list({ assignedTo: emp.id, open: true, limit: 50 }),
  ]);
  const files = await require('../utils/documents').listFor('member', emp.id);
  const tools = await db.prepare('SELECT * FROM assets WHERE assigned_member_id = ? ORDER BY name').all(emp.id);
  const leave = await db.prepare("SELECT * FROM time_off_requests WHERE member_id = ? AND status IN ('pending','approved') AND end_date >= ? ORDER BY start_date").all(emp.id, fmt.today());
  res.render('manage-employee', { title: emp.name, emp, profile: profile || {}, certs, trainingRows, week, truck, openJobs, files, tools, leave, today: fmt.today() });
});

router.post('/employees/:id/profile', requirePermission('employees.manage'), action(async (req, res) => {
  const emp = await db.prepare('SELECT id FROM members WHERE id = ?').get(req.params.id);
  if (!emp) throw new Error('Employee not found.');
  const empNo = fmt.clean(req.body.employee_number, 40);
  if (empNo) {
    const dup = await db.prepare('SELECT member_id FROM employee_profiles WHERE employee_number = ? AND member_id <> ?').get(empNo, emp.id);
    if (dup) throw new Error('That employee number is already used.');
  }
  const rate = fmt.toCents(req.body.pay_rate);
  if (rate !== null && rate < 0) throw new Error('Pay rate cannot be negative.');
  const payType = req.body.pay_type === 'salary' ? 'salary' : 'hourly';
  await db
    .prepare(`INSERT INTO employee_profiles (member_id, employee_number, job_title, hire_date, pay_type, pay_rate_cents, address, emergency_contact, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now_text())
      ON CONFLICT (member_id) DO UPDATE SET employee_number = excluded.employee_number, job_title = excluded.job_title, hire_date = excluded.hire_date, pay_type = excluded.pay_type,
        pay_rate_cents = excluded.pay_rate_cents, address = excluded.address, emergency_contact = excluded.emergency_contact, notes = excluded.notes, updated_at = excluded.updated_at`)
    .run(emp.id, empNo, fmt.clean(req.body.job_title, 100), fmt.dateOnly(req.body.hire_date), payType, rate || 0, fmt.clean(req.body.address, 300), fmt.clean(req.body.emergency_contact, 300), fmt.clean(req.body.notes, 2000));
  await audit.log(req, 'employee.profile', 'member', emp.id, { payType, payRateChanged: true });
  flash(res, `/manage/employees/${emp.id}`, 'notice', 'Employee record saved.');
}, (req) => `/manage/employees/${req.params.id}`));

router.post('/employees/:id/certifications', requirePermission('employees.manage'), action(async (req, res) => {
  const name = fmt.clean(req.body.name, 200);
  if (!name) throw new Error('Certification name is required.');
  const info = await db.prepare('INSERT INTO certifications (member_id, name, number, issued_on, expires_on) VALUES (?, ?, ?, ?, ?)').run(req.params.id, name, fmt.clean(req.body.number, 100), fmt.dateOnly(req.body.issued_on), fmt.dateOnly(req.body.expires_on));
  await audit.log(req, 'certification.create', 'member', req.params.id, { certId: info.lastInsertRowid, name });
  flash(res, `/manage/employees/${req.params.id}`, 'notice', 'Certification added.');
}, (req) => `/manage/employees/${req.params.id}`));

router.post('/employees/:id/certifications/:cid/delete', requirePermission('employees.manage'), action(async (req, res) => {
  await db.prepare('DELETE FROM certifications WHERE id = ? AND member_id = ?').run(req.params.cid, req.params.id);
  await audit.log(req, 'certification.delete', 'member', req.params.id, { certId: req.params.cid });
  flash(res, `/manage/employees/${req.params.id}`, 'notice', 'Certification removed.');
}, (req) => `/manage/employees/${req.params.id}`));

// Sends in-app reminders for certifications expiring within 30 days.
router.post('/employees/cert-reminders', requirePermission('employees.manage'), action(async (req, res) => {
  const due = await db.prepare('SELECT c.*, m.name FROM certifications c JOIN members m ON m.id = c.member_id WHERE m.active = 1 AND c.expires_on IS NOT NULL AND c.expires_on <= ?').all(fmt.addDays(fmt.today(), 30));
  for (const c of due) await notifications.notify(c.member_id, 'certification', { title: `${c.name} ${c.expires_on < fmt.today() ? 'has expired' : 'expires ' + c.expires_on}`, body: 'Please renew and give the office a copy.', linkUrl: '/employee' });
  await audit.log(req, 'certification.reminders', null, null, { count: due.length });
  flash(res, '/manage', 'notice', `Sent ${due.length} certification reminder(s).`);
}, '/manage'));

// ---------------------------------------------------------------- timesheets
router.get('/timesheets', requirePermission('timesheets.approve'), async (req, res) => {
  const date = fmt.dateOnly(req.query.week) || fmt.today();
  const start = fmt.weekStart(date);
  const entries = await timeclock.entries({ from: start + ' 00:00:00', to: fmt.addDays(start, 7) + ' 00:00:00' });
  const threshold = (await settings.getInt('overtime_weekly_hours', 40)) * 60;
  const byMember = {};
  for (const e of entries) {
    const b = (byMember[e.member_id] = byMember[e.member_id] || { memberId: e.member_id, name: e.memberName, total: 0, pending: 0, entries: [] });
    b.entries.push(e);
    if (e.status !== 'rejected') b.total += e.workedMinutes;
    if (e.status === 'pending') b.pending++;
  }
  const people = Object.values(byMember).map((p) => ({ ...p, regular: Math.min(p.total, threshold), overtime: Math.max(0, p.total - threshold) }));
  if (req.query.format === 'csv') {
    const rates = await db.prepare('SELECT member_id, pay_type, pay_rate_cents FROM employee_profiles').all();
    const canPay = req.can('employees.manage');
    res.type('text/csv').attachment(`timesheet-${start}.csv`);
    return res.send(fmt.csv(people, [
      { label: 'Employee', value: 'name' }, { label: 'Week of', value: () => fmt.d(start) }, { label: 'Regular hours', value: (p) => fmt.hours(p.regular) },
      { label: 'Overtime hours', value: (p) => fmt.hours(p.overtime) }, { label: 'Unapproved entries', value: 'pending' },
      ...(canPay ? [{ label: 'Pay type', value: (p) => (rates.find((r) => r.member_id === p.memberId) || {}).pay_type || '' }, { label: 'Rate', value: (p) => fmt.centsInput((rates.find((r) => r.member_id === p.memberId) || {}).pay_rate_cents) }] : []),
    ]));
  }
  res.render('manage-timesheets', { title: 'Timesheets', start, people, corrections: await timeclock.pendingCorrections(), prev: fmt.addDays(start, -7), next: fmt.addDays(start, 7), threshold: threshold / 60 });
});

router.post('/timesheets/decide', requirePermission('timesheets.approve'), action(async (req, res) => {
  const ids = asArray(req.body.entry_ids).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) throw new Error('Select at least one entry.');
  const status = req.body.decision === 'rejected' ? 'rejected' : 'approved';
  const n = await timeclock.decide(ids, status, req.member.id);
  await audit.log(req, 'timesheet.' + status, 'time_entry', null, { ids });
  flash(res, `/manage/timesheets?week=${encodeURIComponent(req.body.week || '')}`, 'notice', `${n} entr${n === 1 ? 'y' : 'ies'} ${status}${n < ids.length ? ' (your own entries and already-decided ones were skipped)' : ''}.`);
}, (req) => `/manage/timesheets?week=${encodeURIComponent(req.body.week || '')}`));

router.post('/timesheets/corrections/:id', requirePermission('timesheets.approve'), action(async (req, res) => {
  const c = await timeclock.decideCorrection(req.params.id, req.body.decision === 'approve', req.member.id);
  await audit.log(req, 'timesheet.correction_' + (req.body.decision === 'approve' ? 'approved' : 'rejected'), 'time_entry', c.entry_id, { correctionId: c.id });
  await notifications.notify(c.member_id, 'timesheet', { title: `Time correction ${req.body.decision === 'approve' ? 'approved' : 'rejected'}`, linkUrl: '/employee/time' });
  flash(res, '/manage/timesheets', 'notice', 'Correction decided.');
}, '/manage/timesheets'));

// ---------------------------------------------------------------- reports
router.get('/reports', requirePermission('jobs.costing', 'accounting.view'), async (req, res) => {
  const today = fmt.today();
  const from = fmt.dateOnly(req.query.from) || today.slice(0, 8) + '01';
  const to = fmt.dateOnly(req.query.to) || today;
  const done = await db
    .prepare("SELECT j.id, j.job_number, j.title, j.job_type, j.completed_at, c.name AS \"customerName\" FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.completed_at >= ? AND j.completed_at <= ? AND j.status <> 'cancelled' ORDER BY j.completed_at")
    .all(from + ' 00:00:00', to + ' 23:59:59');
  const assignments = done.length ? await db.prepare(`SELECT ja.job_id, m.id, m.name FROM job_assignments ja JOIN members m ON m.id = ja.member_id WHERE ja.job_id IN (${done.map(() => '?').join(',')})`).all(...done.map((j) => j.id)) : [];
  const rows = [];
  for (const j of done) rows.push({ ...j, ...(await jobs.costing(j.id)), techs: assignments.filter((a) => a.job_id === j.id) });
  const group = (keyFn) => {
    const out = {};
    for (const r of rows) {
      for (const [key, share] of keyFn(r)) {
        const g = (out[key] = out[key] || { key, jobs: 0, revenue: 0, cost: 0, laborMinutes: 0 });
        g.jobs += share; g.revenue += r.price * share; g.cost += r.totalCost * share; g.laborMinutes += r.laborMinutes * share;
      }
    }
    return Object.values(out).map((g) => ({ ...g, profit: g.revenue - g.cost, margin: g.revenue ? Math.round(((g.revenue - g.cost) / g.revenue) * 1000) / 10 : null, avg: g.jobs ? g.revenue / g.jobs : 0 })).sort((a, b) => b.revenue - a.revenue);
  };
  // Multi-tech jobs are split evenly between the crew.
  const byTech = group((r) => (r.techs.length ? r.techs.map((t) => [t.name, 1 / r.techs.length]) : [['(unassigned)', 1]]));
  const byType = group((r) => [[fmt.label(r.job_type), 1]]);
  const totals = rows.reduce((t, r) => ({ revenue: t.revenue + r.price, cost: t.cost + r.totalCost }), { revenue: 0, cost: 0 });
  // Labor utilization: clocked minutes on jobs vs. all clocked minutes.
  const time = await timeclock.entries({ from: from + ' 00:00:00', to: fmt.addDays(to, 1) + ' 00:00:00' });
  const util = {};
  for (const e of time.filter((x) => x.status !== 'rejected')) {
    const u = (util[e.memberName] = util[e.memberName] || { name: e.memberName, total: 0, onJobs: 0 });
    u.total += e.workedMinutes;
    if (e.job_id) u.onJobs += e.workedMinutes;
  }
  const est = await db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS v FROM estimates WHERE COALESCE(decided_at, sent_at) >= ? AND COALESCE(decided_at, sent_at) <= ? AND status IN ('approved','converted','rejected','expired') GROUP BY status").all(from + ' 00:00:00', to + ' 23:59:59');
  const won = est.filter((e) => ['approved', 'converted'].includes(e.status));
  const estimateStats = { decided: est.reduce((s, e) => s + Number(e.n), 0), won: won.reduce((s, e) => s + Number(e.n), 0), wonValue: won.reduce((s, e) => s + Number(e.v), 0) };
  // Retention: customers served in the window who had also been served before it.
  const served = await db.prepare("SELECT DISTINCT customer_id FROM jobs WHERE completed_at >= ? AND completed_at <= ?").all(from + ' 00:00:00', to + ' 23:59:59');
  const repeat = served.length ? (await db.prepare(`SELECT COUNT(DISTINCT customer_id) AS c FROM jobs WHERE completed_at < ? AND customer_id IN (${served.map(() => '?').join(',')})`).get(from + ' 00:00:00', ...served.map((r) => r.customer_id))).c : 0;
  const retention = { served: served.length, repeat: Number(repeat) };
  const requests = await db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted FROM service_requests WHERE created_at >= ? AND created_at <= ?").get(from + ' 00:00:00', to + ' 23:59:59');
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`job-profitability-${from}-${to}.csv`);
    return res.send(fmt.csv(rows, [
      { label: 'Job', value: 'job_number' }, { label: 'Completed', value: (r) => fmt.d(r.completed_at) }, { label: 'Customer', value: 'customerName' }, { label: 'Type', value: 'job_type' },
      { label: 'Technicians', value: (r) => r.techs.map((t) => t.name).join('; ') }, { label: 'Price', value: (r) => fmt.centsInput(r.price) }, { label: 'Price source', value: 'priceSource' },
      { label: 'Materials', value: (r) => fmt.centsInput(r.materials) }, { label: 'Labor', value: (r) => fmt.centsInput(r.labor) }, { label: 'Labor hours', value: (r) => fmt.hours(r.laborMinutes) },
      { label: 'Other costs', value: (r) => fmt.centsInput(r.equipment + r.subcontractor + r.permit + r.other) }, { label: 'Total cost', value: (r) => fmt.centsInput(r.totalCost) },
      { label: 'Gross profit', value: (r) => fmt.centsInput(r.grossProfit) }, { label: 'Margin %', value: (r) => (r.margin === null ? '' : r.margin) },
    ]));
  }
  res.render('manage-reports', { title: 'Operations Reports', from, to, rows, byTech, byType, totals, util: Object.values(util), requests: { total: Number(requests.total || 0), converted: Number(requests.converted || 0) }, estimateStats, retention });
});

module.exports = router;
