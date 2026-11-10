// Team features: time off, pay stubs, end-of-day reports, announcements,
// employee messaging, and tools & equipment (assets).
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission, forbidden } = require('../middleware/auth');
const db = require('../db');
const payroll = require('../utils/payroll');
const notifications = require('../utils/notifications');
const automation = require('../utils/automation');
const settings = require('../utils/settings');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

router.use(['/employee', '/announcements', '/messages', '/manage', '/assets'], requireAuth);

const LEAVE_KINDS = ['vacation', 'sick', 'personal', 'unpaid'];
function isStaff(req) {
  return req.can('portal.employee', 'portal.service', 'portal.management');
}

// ---------------------------------------------------------------- time off
router.get('/employee/time-off', requirePermission('portal.employee'), async (req, res) => {
  res.render('employee-timeoff', {
    title: 'Time Off', kinds: LEAVE_KINDS, hoursPerDay: await settings.getInt('pto_hours_per_day', 8),
    rows: await db.prepare('SELECT t.*, d.name AS "decidedByName" FROM time_off_requests t LEFT JOIN members d ON d.id = t.decided_by WHERE t.member_id = ? ORDER BY t.start_date DESC').all(req.member.id),
    profile: (await db.prepare('SELECT pto_balance_hours, sick_balance_hours FROM employee_profiles WHERE member_id = ?').get(req.member.id)) || { pto_balance_hours: 0, sick_balance_hours: 0 },
  });
});

router.post('/employee/time-off', requirePermission('portal.employee'), action(async (req, res) => {
  const start = fmt.dateOnly(req.body.start_date);
  const end = fmt.dateOnly(req.body.end_date) || start;
  if (!start) throw new Error('Choose the dates.');
  if (end < start) throw new Error('The end date is before the start date.');
  if (!LEAVE_KINDS.includes(req.body.kind)) throw new Error('Choose the type of leave.');
  const perDay = await settings.getInt('pto_hours_per_day', 8);
  const days = Math.round((fmt.parseTs(end + ' 00:00:00') - fmt.parseTs(start + ' 00:00:00')) / 864e5) + 1;
  const hours = fmt.toNumber(req.body.hours) || days * perDay;
  if (hours <= 0 || hours > days * 24) throw new Error('Check the number of hours.');
  const overlap = await db.prepare("SELECT id FROM time_off_requests WHERE member_id = ? AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?").get(req.member.id, end, start);
  if (overlap) throw new Error('You already have a request covering some of those days.');
  const info = await db.prepare('INSERT INTO time_off_requests (member_id, kind, start_date, end_date, hours, reason) VALUES (?, ?, ?, ?, ?, ?)').run(req.member.id, req.body.kind, start, end, hours, fmt.clean(req.body.reason, 500));
  await audit.log(req, 'timeoff.request', 'time_off', info.lastInsertRowid);
  await automation.notifyPermission(['timeoff.approve'], 'timesheet', { title: `Time-off request from ${req.member.name}`, body: `${fmt.label(req.body.kind)} ${fmt.d(start)} to ${fmt.d(end)} (${hours} h)`, linkUrl: '/manage/time-off' }, req.member.id);
  flash(res, '/employee/time-off', 'notice', 'Request sent to your manager.');
}, '/employee/time-off'));

router.post('/employee/time-off/:id/cancel', requirePermission('portal.employee'), action(async (req, res) => {
  const r = await db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND member_id = ? AND status IN ('pending','approved')").get(req.params.id, req.member.id);
  if (!r) throw new Error('Request not found.');
  if (r.status === 'approved' && r.start_date <= fmt.today()) throw new Error('Approved leave that has started can only be changed by a manager.');
  await db.withTransaction(async (tx) => {
    await tx.prepare("UPDATE time_off_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
    if (r.status === 'approved') await restoreBalance(tx, r);
  });
  await audit.log(req, 'timeoff.cancel', 'time_off', r.id);
  flash(res, '/employee/time-off', 'notice', 'Request cancelled.');
}, '/employee/time-off'));

async function restoreBalance(tx, r) {
  if (r.kind === 'vacation' || r.kind === 'personal') await tx.prepare('UPDATE employee_profiles SET pto_balance_hours = pto_balance_hours + ? WHERE member_id = ?').run(r.hours, r.member_id);
  if (r.kind === 'sick') await tx.prepare('UPDATE employee_profiles SET sick_balance_hours = sick_balance_hours + ? WHERE member_id = ?').run(r.hours, r.member_id);
}

router.get('/manage/time-off', requirePermission('timeoff.approve'), async (req, res) => {
  const rows = await db
    .prepare(`SELECT t.*, m.name, ep.pto_balance_hours, ep.sick_balance_hours, d.name AS "decidedByName" FROM time_off_requests t JOIN members m ON m.id = t.member_id LEFT JOIN employee_profiles ep ON ep.member_id = t.member_id LEFT JOIN members d ON d.id = t.decided_by
      WHERE t.status = 'pending' OR t.end_date >= ? ORDER BY CASE WHEN t.status = 'pending' THEN 0 ELSE 1 END, t.start_date`)
    .all(fmt.addDays(fmt.today(), -30));
  res.render('manage-timeoff', { title: 'Time Off Requests', rows });
});

router.post('/manage/time-off/:id', requirePermission('timeoff.approve'), action(async (req, res) => {
  const approve = req.body.decision === 'approve';
  const r = await db.withTransaction(async (tx) => {
    const t = await tx.prepare("SELECT * FROM time_off_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!t) throw new Error('Request not found or already decided.');
    if (t.member_id === req.member.id) throw new Error("You can't approve your own time off.");
    await tx.prepare('UPDATE time_off_requests SET status = ?, decided_by = ?, decided_at = now_text(), decision_note = ? WHERE id = ?').run(approve ? 'approved' : 'denied', req.member.id, fmt.clean(req.body.note, 500), t.id);
    if (approve) {
      // Paid leave draws down the balance (it may go negative - flagged on screen).
      await tx.prepare("INSERT INTO employee_profiles (member_id) VALUES (?) ON CONFLICT (member_id) DO NOTHING").run(t.member_id);
      if (t.kind === 'vacation' || t.kind === 'personal') await tx.prepare('UPDATE employee_profiles SET pto_balance_hours = pto_balance_hours - ? WHERE member_id = ?').run(t.hours, t.member_id);
      if (t.kind === 'sick') await tx.prepare('UPDATE employee_profiles SET sick_balance_hours = sick_balance_hours - ? WHERE member_id = ?').run(t.hours, t.member_id);
    }
    return t;
  });
  await audit.log(req, approve ? 'timeoff.approve' : 'timeoff.deny', 'time_off', r.id);
  await notifications.notify(r.member_id, 'timesheet', { title: `Time off ${approve ? 'approved' : 'denied'}: ${fmt.d(r.start_date)} to ${fmt.d(r.end_date)}`, body: fmt.clean(req.body.note, 200) || '', linkUrl: '/employee/time-off' });
  flash(res, '/manage/time-off', 'notice', approve ? 'Approved.' : 'Denied.');
}, '/manage/time-off'));

router.post('/manage/employees/:id/leave-balance', requirePermission('employees.manage', 'timeoff.approve'), action(async (req, res) => {
  const pto = fmt.toNumber(req.body.pto_balance_hours);
  const sick = fmt.toNumber(req.body.sick_balance_hours);
  if (pto === null || sick === null) throw new Error('Enter both balances.');
  await db.prepare('INSERT INTO employee_profiles (member_id) VALUES (?) ON CONFLICT (member_id) DO NOTHING').run(req.params.id);
  await db.prepare('UPDATE employee_profiles SET pto_balance_hours = ?, sick_balance_hours = ? WHERE member_id = ?').run(pto, sick, req.params.id);
  await audit.log(req, 'timeoff.balance', 'member', req.params.id, { pto, sick });
  flash(res, `/manage/employees/${req.params.id}`, 'notice', 'Leave balances updated.');
}, (req) => `/manage/employees/${req.params.id}`));

// ---------------------------------------------------------------- pay stubs
router.get('/employee/pay', requirePermission('portal.employee'), async (req, res) => {
  const year = fmt.today().slice(0, 4);
  res.render('employee-pay', { title: 'My Pay', stubs: await payroll.stubsFor(req.member.id), ytd: await payroll.ytd(req.member.id, year), year });
});

router.get('/employee/pay/:itemId', requirePermission('portal.employee'), async (req, res) => {
  const s = await payroll.stub(req.member.id, req.params.itemId);
  if (!s) return res.status(404).render('404', { title: 'Not Found' });
  res.render('employee-paystub', { title: `Pay stub ${fmt.d(s.pay_date)}`, s, ytd: await payroll.ytd(req.member.id, s.pay_date.slice(0, 4)), company: await settings.all() });
});

// ---------------------------------------------------------------- end-of-day reports
router.get('/employee/report', requirePermission('portal.employee'), async (req, res) => {
  const today = fmt.today();
  res.render('employee-report', {
    title: 'End-of-Day Report', today,
    existing: await db.prepare('SELECT * FROM daily_reports WHERE member_id = ? AND report_date = ?').get(req.member.id, today),
    recent: await db.prepare('SELECT * FROM daily_reports WHERE member_id = ? ORDER BY report_date DESC LIMIT 10').all(req.member.id),
    jobsToday: await db.prepare("SELECT j.job_number, j.title, j.status FROM jobs j JOIN job_assignments ja ON ja.job_id = j.id WHERE ja.member_id = ? AND (j.scheduled_start LIKE ? OR j.completed_at LIKE ?)").all(req.member.id, today + '%', today + '%'),
  });
});

router.post('/employee/report', requirePermission('portal.employee'), action(async (req, res) => {
  const summary = fmt.clean(req.body.summary, 5000);
  if (!summary) throw new Error('Summarize your day.');
  const date = fmt.today();
  await db
    .prepare(`INSERT INTO daily_reports (member_id, report_date, summary, issues, materials_needed, mileage) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (member_id, report_date) DO UPDATE SET summary = excluded.summary, issues = excluded.issues, materials_needed = excluded.materials_needed, mileage = excluded.mileage`)
    .run(req.member.id, date, summary, fmt.clean(req.body.issues, 2000), fmt.clean(req.body.materials_needed, 2000), fmt.toNumber(req.body.mileage));
  if (fmt.clean(req.body.issues)) await automation.notifyPermission(['dailyreports.view'], 'job_status', { title: `Issue reported by ${req.member.name}`, body: fmt.clean(req.body.issues, 200), linkUrl: '/manage/daily-reports' }, req.member.id);
  flash(res, '/employee', 'notice', 'End-of-day report submitted. Thanks!');
}, '/employee/report'));

router.get('/manage/daily-reports', requirePermission('dailyreports.view'), async (req, res) => {
  const date = fmt.dateOnly(req.query.date) || fmt.today();
  res.render('manage-daily-reports', {
    title: 'End-of-Day Reports', date, prev: fmt.addDays(date, -1), next: fmt.addDays(date, 1),
    rows: await db.prepare('SELECT d.*, m.name FROM daily_reports d JOIN members m ON m.id = d.member_id WHERE d.report_date = ? ORDER BY m.name').all(date),
  });
});

// ---------------------------------------------------------------- announcements
router.get('/announcements', async (req, res) => {
  if (!isStaff(req)) return forbidden(res);
  res.render('announcements', { title: 'Announcements', rows: await visibleAnnouncements(req.member, 100), roles: await db.prepare('SELECT key, name FROM roles ORDER BY position').all() });
});

async function visibleAnnouncements(member, limit = 5) {
  return db
    .prepare(`SELECT a.*, m.name AS "authorName", r.name AS "roleName" FROM announcements a LEFT JOIN members m ON m.id = a.created_by LEFT JOIN roles r ON r.key = a.audience_role
      WHERE (a.audience_role IS NULL OR a.audience_role = ?) AND (a.expires_on IS NULL OR a.expires_on >= ?) ORDER BY a.pinned DESC, a.id DESC LIMIT ${limit}`)
    .all(member.role, fmt.today());
}

router.post('/announcements', requirePermission('announcements.manage'), action(async (req, res) => {
  const title = fmt.clean(req.body.title, 200);
  const body = fmt.clean(req.body.body, 5000);
  if (!title || !body) throw new Error('Title and message are required.');
  const role = req.body.audience_role || null;
  const info = await db.prepare('INSERT INTO announcements (title, body, audience_role, pinned, expires_on, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(title, body, role, req.body.pinned === '1' ? 1 : 0, fmt.dateOnly(req.body.expires_on), req.member.id);
  const people = (await db.prepare("SELECT id, role FROM members WHERE active = 1 AND role NOT IN ('customer','student')").all()).filter((p) => !role || p.role === role);
  for (const p of people) if (p.id !== req.member.id) await notifications.notify(p.id, 'document_added', { title: `Announcement: ${title}`, body: body.slice(0, 140), linkUrl: '/announcements' });
  await audit.log(req, 'announcement.create', 'announcement', info.lastInsertRowid);
  flash(res, '/announcements', 'notice', `Posted to ${people.length} people.`);
}, '/announcements'));

router.post('/announcements/:id/delete', requirePermission('announcements.manage'), action(async (req, res) => {
  await db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  await audit.log(req, 'announcement.delete', 'announcement', req.params.id);
  flash(res, '/announcements', 'notice', 'Removed.');
}, '/announcements'));

// ---------------------------------------------------------------- messages
async function messageable() {
  const perms = require('../utils/permissions');
  return perms.membersWith('messages.use');
}

router.get('/messages', requirePermission('messages.use'), async (req, res) => {
  const convos = await db
    .prepare(`SELECT other_id, MAX(id) AS last_id, SUM(unread) AS unread FROM (
        SELECT id, CASE WHEN from_id = ? THEN to_id ELSE from_id END AS other_id, CASE WHEN to_id = ? AND read_at IS NULL THEN 1 ELSE 0 END AS unread
        FROM direct_messages WHERE from_id = ? OR to_id = ?) x GROUP BY other_id ORDER BY last_id DESC`)
    .all(req.member.id, req.member.id, req.member.id, req.member.id);
  const people = await db.prepare('SELECT id, name FROM members').all();
  const lasts = convos.length ? await db.prepare(`SELECT id, body, created_at FROM direct_messages WHERE id IN (${convos.map(() => '?').join(',')})`).all(...convos.map((c) => c.last_id)) : [];
  res.render('messages', {
    title: 'Messages', convos: convos.map((c) => ({ ...c, name: (people.find((p) => p.id === c.other_id) || {}).name, last: lasts.find((l) => l.id === c.last_id) })),
    contacts: (await messageable()).filter((p) => p.id !== req.member.id),
  });
});

router.get('/messages/:memberId', requirePermission('messages.use'), async (req, res) => {
  const other = await db.prepare('SELECT id, name, role, active FROM members WHERE id = ?').get(req.params.memberId);
  if (!other || other.id === req.member.id) return res.status(404).render('404', { title: 'Not Found' });
  const thread = await db
    .prepare('SELECT * FROM direct_messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 200')
    .all(req.member.id, other.id, other.id, req.member.id);
  await db.prepare('UPDATE direct_messages SET read_at = now_text() WHERE to_id = ? AND from_id = ? AND read_at IS NULL').run(req.member.id, other.id);
  res.render('messages-thread', { title: `Messages with ${other.name}`, other, thread: thread.reverse() });
});

router.post('/messages/:memberId', requirePermission('messages.use'), action(async (req, res) => {
  const body = fmt.clean(req.body.body, 4000);
  if (!body) throw new Error('Type a message.');
  const allowed = (await messageable()).some((p) => String(p.id) === String(req.params.memberId));
  if (!allowed || String(req.params.memberId) === String(req.member.id)) throw new Error('That person cannot receive messages.');
  await db.prepare('INSERT INTO direct_messages (from_id, to_id, body) VALUES (?, ?, ?)').run(req.member.id, req.params.memberId, body);
  await notifications.notify(parseInt(req.params.memberId, 10), 'forum_reply', { title: `Message from ${req.member.name}`, body: body.slice(0, 140), linkUrl: `/messages/${req.member.id}` });
  res.redirect(`/messages/${req.params.memberId}#end`);
}, (req) => `/messages/${req.params.memberId}`));

// ---------------------------------------------------------------- tools & equipment
router.get('/assets', requirePermission('assets.manage'), async (req, res) => {
  res.render('assets', {
    title: 'Tools & Equipment', today: fmt.today(),
    rows: await db.prepare('SELECT a.*, m.name AS "memberName", t.name AS "truckName" FROM assets a LEFT JOIN members m ON m.id = a.assigned_member_id LEFT JOIN trucks t ON t.id = a.truck_id ORDER BY a.status, a.name').all(),
    staff: await db.prepare("SELECT id, name FROM members WHERE active = 1 AND role NOT IN ('customer','student') ORDER BY name").all(),
    trucks: await db.prepare('SELECT id, name FROM trucks WHERE active = 1 ORDER BY name').all(),
  });
});

router.post('/assets', requirePermission('assets.manage'), action(async (req, res) => {
  const name = fmt.clean(req.body.name, 200);
  if (!name) throw new Error('Name is required.');
  const status = ['in_service', 'repair', 'lost', 'retired'].includes(req.body.status) ? req.body.status : 'in_service';
  const vals = [name, fmt.clean(req.body.category, 100), fmt.clean(req.body.serial_number, 100), parseInt(req.body.assigned_member_id, 10) || null, parseInt(req.body.truck_id, 10) || null, status,
    fmt.dateOnly(req.body.purchase_date), fmt.toCents(req.body.cost), fmt.dateOnly(req.body.next_service_on), fmt.clean(req.body.notes, 1000)];
  const id = parseInt(req.body.id, 10);
  if (id) await db.prepare('UPDATE assets SET name = ?, category = ?, serial_number = ?, assigned_member_id = ?, truck_id = ?, status = ?, purchase_date = ?, cost_cents = ?, next_service_on = ?, notes = ? WHERE id = ?').run(...vals, id);
  else await db.prepare('INSERT INTO assets (name, category, serial_number, assigned_member_id, truck_id, status, purchase_date, cost_cents, next_service_on, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals);
  await audit.log(req, id ? 'asset.update' : 'asset.create', 'asset', id || null, { name, assigned: vals[3] });
  flash(res, '/assets', 'notice', 'Saved.');
}, '/assets'));

module.exports = router;
module.exports.visibleAnnouncements = visibleAnnouncements;
