const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const notifications = require('../utils/notifications');

router.use(requireAuth);

router.get('/', async (req, res) => {
  res.render('notifications-list', { title: 'Notifications', items: await notifications.listForMember(req.member.id) });
});

router.post('/:id/read', async (req, res) => {
  await notifications.markRead(req.member.id, req.params.id);
  res.redirect(req.get('Referer') || '/notifications');
});

router.post('/read-all', async (req, res) => {
  await notifications.markAllRead(req.member.id);
  res.redirect('/notifications');
});

module.exports = router;
