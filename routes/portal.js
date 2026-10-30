const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');
const events = require('../utils/events');
const training = require('../utils/training');
const notifications = require('../utils/notifications');
const { ROLES, findById, findByEmail, hashPassword } = require('../utils/auth');

router.use(requireAuth);

router.get('/portal', async (req, res) => {
  const upcomingEvents = (await events.listUpcoming()).slice(0, 3);
  const myTraining = (await training.myAssignments(req.member.id)).filter((a) => a.status !== 'passed').slice(0, 3);
  const recentNotifications = (await notifications.listForMember(req.member.id)).slice(0, 5);
  res.render('portal-home', { title: 'My Portal', upcomingEvents, myTraining, recentNotifications });
});

router.get('/portal/members', requireRole('admin'), async (req, res) => {
  const members = await db.prepare('SELECT id, name, email, role, active, created_at FROM members ORDER BY name').all();
  res.render('portal-members', { title: 'Manage Members', members, notice: req.query.notice || null });
});

router.post('/portal/members/:id/role', requireRole('admin'), async (req, res) => {
  const role = ['student', 'instructor', 'admin'].includes(req.body.role) ? req.body.role : 'student';
  await db.prepare('UPDATE members SET role = ? WHERE id = ?').run(role, req.params.id);
  res.redirect('/portal/members?notice=' + encodeURIComponent('Role updated.'));
});

router.post('/portal/members/:id/active', requireRole('admin'), async (req, res) => {
  await db.prepare('UPDATE members SET active = ? WHERE id = ?').run(req.body.active === '1' ? 1 : 0, req.params.id);
  res.redirect('/portal/members?notice=' + encodeURIComponent('Updated.'));
});

router.get('/portal/members/:id/edit', requireRole('admin'), async (req, res) => {
  const member = await findById(req.params.id);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  res.render('portal-member-edit', { title: `Edit ${member.name}`, editMember: member, isSelf: member.id === req.member.id, error: req.query.error || null });
});

router.post('/portal/members/:id/edit', requireRole('admin'), async (req, res) => {
  const member = await findById(req.params.id);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  const back = (msg) => res.redirect(`/portal/members/${member.id}/edit?error=` + encodeURIComponent(msg));

  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const phone = (req.body.phone || '').trim() || null;
  const isSelf = member.id === req.member.id;
  // An admin can't demote or deactivate themselves - otherwise the last
  // admin could lock everyone out of this page.
  const role = isSelf ? member.role : ROLES.includes(req.body.role) ? req.body.role : member.role;
  const active = isSelf ? 1 : req.body.active === '1' ? 1 : 0;
  const password = req.body.password || '';

  if (!name || !email) return back('Name and email are required.');
  const existing = await findByEmail(email);
  if (existing && existing.id !== member.id) return back('Another member already uses that email.');
  if (password && password.length < 8) return back('New password must be at least 8 characters.');

  await db.prepare('UPDATE members SET name = ?, email = ?, phone = ?, role = ?, active = ? WHERE id = ?').run(name, email, phone, role, active, member.id);
  if (password) await db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(password), member.id);
  res.redirect('/portal/members?notice=' + encodeURIComponent(`Saved changes to ${name}.`));
});

module.exports = router;
