const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const events = require('../utils/events');
const training = require('../utils/training');
const notifications = require('../utils/notifications');
const permissions = require('../utils/permissions');
const audit = require('../utils/audit');
const { findById, findByEmail, hashPassword, createMember } = require('../utils/auth');

router.use(['/portal', '/home'], requireAuth);

router.get('/home', (req, res) => res.redirect(res.locals.homeHref));

// Original training/events home page - still the landing page for the
// Trainee and Instructor roles, and linked from every other portal.
router.get('/portal', async (req, res) => {
  if (req.can('portal.customer') && !req.can('training.view')) return res.redirect('/my');
  const upcomingEvents = req.can('events.view', 'events.manage') ? (await events.listUpcoming()).slice(0, 3) : [];
  const myTraining = (await training.myAssignments(req.member.id)).filter((a) => a.status !== 'passed').slice(0, 3);
  const recentNotifications = (await notifications.listForMember(req.member.id)).slice(0, 5);
  res.render('portal-home', { title: 'My Portal', upcomingEvents, myTraining, recentNotifications });
});

// Roles that carry owner-level power can only be granted - and accounts
// holding them can only be edited - by an owner, so a manager with
// users.manage can't escalate themselves or take over an owner account.
async function isPrivilegedRole(roleKey) {
  const perms = await permissions.permissionsForRole(roleKey);
  return perms.has('system.admin') || perms.has('roles.manage');
}
async function canTouch(req, roleKey) {
  return req.can('system.admin') || !(await isPrivilegedRole(roleKey));
}

router.get('/portal/members', requirePermission('users.manage'), async (req, res) => {
  const members = await db
    .prepare('SELECT m.id, m.name, m.email, m.role, m.active, m.created_at, m.last_login_at, r.name AS "roleName" FROM members m LEFT JOIN roles r ON r.key = m.role ORDER BY m.name')
    .all();
  res.render('portal-members', { title: 'Users & Roles', members, roles: await permissions.listRoles(), notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/portal/members/new', requirePermission('users.manage'), async (req, res) => {
  const back = (k, msg) => res.redirect('/portal/members?' + k + '=' + encodeURIComponent(msg));
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const role = req.body.role;
  if (!name || !email || password.length < 8) return back('error', 'Name, email and a temporary password of at least 8 characters are required.');
  if (!(await permissions.getRole(role))) return back('error', 'Choose a valid role.');
  if (!(await canTouch(req, role))) return back('error', 'Only an owner can create an account with that role.');
  if (await findByEmail(email)) return back('error', 'An account with that email already exists.');
  const id = await createMember({ name, email, password, role });
  await db.prepare('UPDATE members SET phone = ?, must_change_password = 1 WHERE id = ?').run((req.body.phone || '').trim() || null, id);
  await audit.log(req, 'member.create', 'member', id, { role });
  back('notice', `Created ${name}.`);
});

router.post('/portal/members/:id/role', requirePermission('users.manage'), async (req, res) => {
  const target = await findById(req.params.id);
  const role = req.body.role;
  if (!target || !(await permissions.getRole(role))) return res.redirect('/portal/members?error=' + encodeURIComponent('Invalid role.'));
  if (target.id === req.member.id) return res.redirect('/portal/members?error=' + encodeURIComponent("You can't change your own role."));
  if (!(await canTouch(req, role)) || !(await canTouch(req, target.role))) return res.redirect('/portal/members?error=' + encodeURIComponent('Only an owner can grant or change owner-level roles.'));
  await db.prepare('UPDATE members SET role = ? WHERE id = ?').run(role, target.id);
  await audit.log(req, 'member.role', 'member', target.id, { from: target.role, to: role });
  res.redirect('/portal/members?notice=' + encodeURIComponent('Role updated.'));
});

router.post('/portal/members/:id/active', requirePermission('users.manage'), async (req, res) => {
  const target = await findById(req.params.id);
  if (!target) return res.status(404).render('404', { title: 'Not Found' });
  if (target.id === req.member.id) return res.redirect('/portal/members?error=' + encodeURIComponent("You can't deactivate your own account."));
  if (!(await canTouch(req, target.role))) return res.redirect('/portal/members?error=' + encodeURIComponent('Only an owner can change an owner account.'));
  const active = req.body.active === '1' ? 1 : 0;
  await db.prepare('UPDATE members SET active = ? WHERE id = ?').run(active, target.id);
  await audit.log(req, active ? 'member.activate' : 'member.deactivate', 'member', target.id);
  res.redirect('/portal/members?notice=' + encodeURIComponent('Updated.'));
});

router.get('/portal/members/:id/edit', requirePermission('users.manage'), async (req, res) => {
  const member = await findById(req.params.id);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  res.render('portal-member-edit', { title: `Edit ${member.name}`, editMember: member, roles: await permissions.listRoles(), isSelf: member.id === req.member.id, error: req.query.error || null });
});

router.post('/portal/members/:id/edit', requirePermission('users.manage'), async (req, res) => {
  const member = await findById(req.params.id);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  const back = (msg) => res.redirect(`/portal/members/${member.id}/edit?error=` + encodeURIComponent(msg));

  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim() || null;
  const isSelf = member.id === req.member.id;
  // Nobody can demote or deactivate themselves - otherwise the last
  // owner could lock everyone out of this page.
  const role = isSelf ? member.role : (await permissions.getRole(req.body.role)) ? req.body.role : member.role;
  const active = isSelf ? 1 : req.body.active === '1' ? 1 : 0;
  const password = req.body.password || '';

  if (!isSelf && (!(await canTouch(req, member.role)) || !(await canTouch(req, role)))) return back('Only an owner can edit owner-level accounts or grant owner-level roles.');
  if (!name || !email) return back('Name and email are required.');
  const existing = await findByEmail(email);
  if (existing && existing.id !== member.id) return back('Another member already uses that email.');
  if (password && password.length < 8) return back('New password must be at least 8 characters.');

  await db.prepare('UPDATE members SET name = ?, email = ?, phone = ?, role = ?, active = ? WHERE id = ?').run(name, email, phone, role, active, member.id);
  // A password set by someone else is temporary: they must change it.
  if (password) await db.prepare('UPDATE members SET password_hash = ?, failed_logins = 0, locked_until = NULL, must_change_password = ? WHERE id = ?').run(hashPassword(password), isSelf ? 0 : 1, member.id);
  const resetMfa = req.body.reset_mfa === '1' && !isSelf;
  if (resetMfa) await db.prepare('UPDATE members SET mfa_secret = NULL, mfa_enabled = 0 WHERE id = ?').run(member.id);
  await audit.log(req, 'member.update', 'member', member.id, { role, active, passwordReset: Boolean(password), mfaReset: resetMfa });
  res.redirect('/portal/members?notice=' + encodeURIComponent(`Saved changes to ${name}.`));
});

module.exports = router;
