const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');
const events = require('../utils/events');
const training = require('../utils/training');
const notifications = require('../utils/notifications');

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

module.exports = router;
