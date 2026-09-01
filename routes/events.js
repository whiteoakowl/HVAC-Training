const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const events = require('../utils/events');
const notifications = require('../utils/notifications');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const upcoming = await events.listUpcoming();
  const withStatus = [];
  for (const e of upcoming) withStatus.push({ ...e, registered: await events.isRegistered(e.id, req.member.id) });
  res.render('events-list', { title: 'Events', events: withStatus });
});

router.get('/manage', requireRole('instructor'), async (req, res) => {
  const all = await events.listAll();
  res.render('events-manage', { title: 'Manage Events', events: all, notice: req.query.notice || null });
});

router.get('/new', requireRole('instructor'), (req, res) => {
  res.render('events-form', { title: 'New Event', event: null, error: req.query.error || null });
});

router.post('/new', requireRole('instructor'), async (req, res) => {
  const title = (req.body.title || '').trim();
  const startsAt = req.body.startsAt ? req.body.startsAt.replace('T', ' ') + ':00' : null;
  if (!title || !startsAt) return res.redirect('/events/new?error=' + encodeURIComponent('Title and start date/time are required.'));
  await events.createEvent(
    {
      title,
      description: (req.body.description || '').trim(),
      location: (req.body.location || '').trim(),
      category: (req.body.category || '').trim(),
      startsAt,
      endsAt: req.body.endsAt ? req.body.endsAt.replace('T', ' ') + ':00' : null,
      capacity: req.body.capacity ? parseInt(req.body.capacity, 10) : null,
      visibility: req.body.visibility === 'public' ? 'public' : 'members',
    },
    req.member.id
  );
  res.redirect('/events/manage?notice=' + encodeURIComponent('Event created.'));
});

router.get('/:id/edit', requireRole('instructor'), async (req, res) => {
  const event = await events.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  res.render('events-form', { title: 'Edit Event', event, error: req.query.error || null });
});

router.post('/:id/edit', requireRole('instructor'), async (req, res) => {
  const title = (req.body.title || '').trim();
  const startsAt = req.body.startsAt ? req.body.startsAt.replace('T', ' ') + ':00' : null;
  if (!title || !startsAt) return res.redirect(`/events/${req.params.id}/edit?error=` + encodeURIComponent('Title and start date/time are required.'));
  await events.updateEvent(req.params.id, {
    title,
    description: (req.body.description || '').trim(),
    location: (req.body.location || '').trim(),
    category: (req.body.category || '').trim(),
    startsAt,
    endsAt: req.body.endsAt ? req.body.endsAt.replace('T', ' ') + ':00' : null,
    capacity: req.body.capacity ? parseInt(req.body.capacity, 10) : null,
    visibility: req.body.visibility === 'public' ? 'public' : 'members',
  });
  res.redirect('/events/manage?notice=' + encodeURIComponent('Event updated.'));
});

router.post('/:id/delete', requireRole('instructor'), async (req, res) => {
  await events.deleteEvent(req.params.id);
  res.redirect('/events/manage?notice=' + encodeURIComponent('Event deleted.'));
});

router.get('/:id', async (req, res) => {
  const event = await events.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const registrations = await events.registrationsFor(event.id);
  res.render('events-detail', {
    title: event.title,
    event,
    registrations,
    isRegistered: await events.isRegistered(event.id, req.member.id),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/:id/register', async (req, res) => {
  const result = await events.register(req.params.id, req.member.id);
  if (!result.ok) return res.redirect(`/events/${req.params.id}?error=` + encodeURIComponent(result.error));
  await notifications.notify(req.member.id, 'event_registration', { title: 'Event Registration Confirmed', body: result.notice, linkUrl: `/events/${req.params.id}` });
  res.redirect(`/events/${req.params.id}?notice=` + encodeURIComponent(result.notice));
});

router.post('/:id/unregister', async (req, res) => {
  await events.unregister(req.params.id, req.member.id);
  res.redirect(`/events/${req.params.id}?notice=` + encodeURIComponent('Registration cancelled.'));
});

module.exports = router;
