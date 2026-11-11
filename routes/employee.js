// Employee portal (mobile-first): my day, my jobs, time clock, my truck,
// parts requests. Everything here is scoped to the signed-in member.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const jobs = require('../utils/jobs');
const timeclock = require('../utils/timeclock');
const inventory = require('../utils/inventory');
const training = require('../utils/training');
const settings = require('../utils/settings');
const automation = require('../utils/automation');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

router.use(requireAuth);

async function myTruck(memberId) {
  return db.prepare('SELECT t.*, l.id AS "locationId" FROM trucks t JOIN inventory_locations l ON l.truck_id = t.id WHERE t.assigned_member_id = ? AND t.active = 1 ORDER BY t.id LIMIT 1').get(memberId);
}

router.get('/', requirePermission('portal.employee'), async (req, res) => {
  const today = fmt.today();
  const [todayJobs, openJobs, entry, week, truck, assignments, certs, profile] = await Promise.all([
    jobs.list({ assignedTo: req.member.id, from: today + ' 00:00:00', to: today + ' 23:59:59' }),
    jobs.list({ assignedTo: req.member.id, open: true }),
    req.can('timeclock.use') ? timeclock.openEntry(req.member.id) : null,
    req.can('timeclock.use') ? timeclock.weekSummary(req.member.id, today) : null,
    myTruck(req.member.id),
    req.can('training.view') ? training.myAssignments(req.member.id) : [],
    db.prepare('SELECT * FROM certifications WHERE member_id = ? ORDER BY expires_on').all(req.member.id),
    db.prepare('SELECT * FROM employee_profiles WHERE member_id = ?').get(req.member.id),
  ]);
  const onBreak = entry ? await timeclock.openBreak(entry.id) : null;
  const announcements = await require('./team').visibleAnnouncements(req.member, 3);
  const payroll = require('../utils/payroll');
  const lastStub = (await payroll.stubsFor(req.member.id))[0] || null;
  const ytd = await payroll.ytd(req.member.id, today.slice(0, 4));
  const pendingLeave = await db.prepare("SELECT COUNT(*) AS c FROM time_off_requests WHERE member_id = ? AND status = 'pending'").get(req.member.id);
  const reportDone = await db.prepare('SELECT 1 AS x FROM daily_reports WHERE member_id = ? AND report_date = ?').get(req.member.id, today);
  let meetings = [];
  if (req.can('meetings.view')) {
    const M = require('../utils/meetings');
    const scope = { can: (...k) => (k.includes('meetings.manage') ? false : req.can(...k)), member: req.member };
    const now = fmt.nowText();
    meetings = (await M.list(scope, { from: today, includeCancelled: false })).filter((m) => M.endsAt(m) > now).slice(0, 3).map((m) => ({ ...m, phase: M.phase(m, now) }));
  }
  res.render('employee-home', {
    announcements, meetings, reportDone, lastStub, ytd, pendingLeave: pendingLeave.c,
    title: 'My Day', todayJobs, upcoming: openJobs.filter((j) => !todayJobs.some((t) => t.id === j.id)).slice(0, 10), entry, onBreak, week, truck,
    trainingDue: assignments.filter((a) => a.status !== 'passed'), certs, profile, soon: fmt.addDays(today, 60), today, gps: await settings.getBool('gps_clock_enabled'),
  });
});

router.get('/jobs', requirePermission('jobs.view_assigned', 'jobs.work'), async (req, res) => {
  const show = req.query.show === 'done' ? 'done' : 'open';
  const all = await jobs.list({ assignedTo: req.member.id, limit: 500 });
  const rows = all.filter((j) => (show === 'open' ? !jobs.CLOSED.includes(j.status) : jobs.CLOSED.includes(j.status)));
  res.render('employee-jobs', { title: 'My Jobs', rows, show });
});

// ---------------------------------------------------------------- time clock
router.get('/time', requirePermission('timeclock.use'), async (req, res) => {
  const date = fmt.dateOnly(req.query.week) || fmt.today();
  const week = await timeclock.weekSummary(req.member.id, date);
  const entry = await timeclock.openEntry(req.member.id);
  const onBreak = entry ? await timeclock.openBreak(entry.id) : null;
  const myJobs = (await jobs.list({ assignedTo: req.member.id, open: true })).slice(0, 30);
  const corrections = await db.prepare('SELECT * FROM time_corrections WHERE member_id = ? ORDER BY id DESC LIMIT 10').all(req.member.id);
  res.render('employee-time', {
    title: 'Time Clock', week, entry, onBreak, myJobs, corrections, gps: await settings.getBool('gps_clock_enabled'),
    prevWeek: fmt.addDays(week.start, -7), nextWeek: fmt.addDays(week.start, 7), threshold: await settings.getInt('overtime_weekly_hours', 40),
  });
});

router.post('/time/in', requirePermission('timeclock.use'), action(async (req, res) => {
  const jobId = req.body.job_id ? parseInt(req.body.job_id, 10) : null;
  if (jobId && !(await jobs.isAssigned(jobId, req.member.id))) throw new Error('You can only clock in to jobs assigned to you.');
  const id = await timeclock.clockIn(req.member.id, { jobId, lat: req.body.lat, lng: req.body.lng, notes: req.body.notes });
  await audit.log(req, 'time.clock_in', 'time_entry', id, { jobId, gps: Boolean(req.body.lat) });
  flash(res, req.body.back === 'home' ? '/employee' : '/employee/time', 'notice', 'Clocked in.');
}, '/employee/time'));

router.post('/time/out', requirePermission('timeclock.use'), action(async (req, res) => {
  const id = await timeclock.clockOut(req.member.id, { lat: req.body.lat, lng: req.body.lng, notes: req.body.notes });
  await audit.log(req, 'time.clock_out', 'time_entry', id, { gps: Boolean(req.body.lat) });
  flash(res, req.body.back === 'home' ? '/employee' : '/employee/time', 'notice', 'Clocked out. Your time was sent for approval.');
}, '/employee/time'));

router.post('/time/break-start', requirePermission('timeclock.use'), action(async (req, res) => {
  await timeclock.startBreak(req.member.id);
  flash(res, req.body.back === 'home' ? '/employee' : '/employee/time', 'notice', 'Break started.');
}, '/employee/time'));

router.post('/time/break-end', requirePermission('timeclock.use'), action(async (req, res) => {
  await timeclock.endBreak(req.member.id);
  flash(res, req.body.back === 'home' ? '/employee' : '/employee/time', 'notice', 'Back from break.');
}, '/employee/time'));

router.post('/time/:id/correction', requirePermission('timeclock.use'), action(async (req, res) => {
  await timeclock.requestCorrection(req.member.id, req.params.id, { clockIn: req.body.clock_in, clockOut: req.body.clock_out, reason: req.body.reason });
  await audit.log(req, 'time.correction_request', 'time_entry', req.params.id);
  await automation.notifyPermission(['timesheets.approve'], 'timesheet', { title: `Time correction request from ${req.member.name}`, body: fmt.clean(req.body.reason, 200), linkUrl: '/manage/timesheets' }, req.member.id);
  flash(res, '/employee/time', 'notice', 'Correction requested. A manager will review it.');
}, '/employee/time'));

// ---------------------------------------------------------------- truck
router.get('/truck', requirePermission('inventory.use'), async (req, res) => {
  const truck = await myTruck(req.member.id);
  const stock = truck ? await inventory.stockAt(truck.locationId) : [];
  const history = truck ? await inventory.transactions({ locationId: truck.locationId, limit: 50 }) : [];
  const tools = await db.prepare('SELECT * FROM assets WHERE assigned_member_id = ? OR truck_id = ? ORDER BY name').all(req.member.id, truck ? truck.id : 0);
  res.render('employee-truck', { title: 'My Truck', truck, stock, history, tools });
});

// ---------------------------------------------------------------- parts requests
router.get('/parts', requirePermission('inventory.use'), async (req, res) => {
  const rows = await db
    .prepare('SELECT pr.*, i.name AS "itemName", j.job_number, d.name AS "decidedByName" FROM parts_requests pr LEFT JOIN inventory_items i ON i.id = pr.item_id LEFT JOIN jobs j ON j.id = pr.job_id LEFT JOIN members d ON d.id = pr.decided_by WHERE pr.member_id = ? ORDER BY pr.id DESC LIMIT 100')
    .all(req.member.id);
  res.render('employee-parts', {
    title: 'Parts & Supply Requests', rows, items: await inventory.listItems(), myJobs: await jobs.list({ assignedTo: req.member.id, open: true }), jobId: parseInt(req.query.job_id, 10) || null,
  });
});

router.post('/parts', requirePermission('inventory.use'), action(async (req, res) => {
  const qty = fmt.toNumber(req.body.quantity) || 1;
  if (qty <= 0) throw new Error('Quantity must be greater than zero.');
  const itemId = req.body.item_id ? parseInt(req.body.item_id, 10) : null;
  const item = itemId ? await inventory.getItem(itemId) : null;
  const description = fmt.clean(req.body.description, 1000) || (item ? item.name : null);
  if (!description) throw new Error('Choose an item or describe what you need.');
  const jobId = req.body.job_id ? parseInt(req.body.job_id, 10) : null;
  if (jobId && !(await jobs.isAssigned(jobId, req.member.id))) throw new Error('That job is not assigned to you.');
  const info = await db.prepare('INSERT INTO parts_requests (member_id, job_id, item_id, description, quantity) VALUES (?, ?, ?, ?, ?)').run(req.member.id, jobId, item ? item.id : null, description, qty);
  await audit.log(req, 'parts_request.create', 'parts_request', info.lastInsertRowid);
  await automation.notifyPermission(['inventory.manage'], 'parts_request', { title: `Parts request from ${req.member.name}`, body: `${qty} x ${description}`, linkUrl: '/inventory/parts-requests' }, req.member.id);
  flash(res, '/employee/parts', 'notice', 'Request sent to the warehouse.');
}, '/employee/parts'));

module.exports = router;
