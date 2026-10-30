const express = require('express');
const router = express.Router();
const { findByEmail, verifyPassword, createMember } = require('../utils/auth');

router.get('/login', (req, res) => {
  if (req.member) return res.redirect('/portal');
  res.render('login', { title: 'Log In', error: req.query.error || null, next: req.query.next || '/portal' });
});

router.post('/login', async (req, res) => {
  const member = await findByEmail(req.body.email);
  if (!member || !(await verifyPassword(member, req.body.password))) {
    return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
  }
  req.session.memberId = member.id;
  res.redirect(req.body.next && req.body.next.startsWith('/') ? req.body.next : '/portal');
});

router.get('/register', (req, res) => {
  if (req.member) return res.redirect('/portal');
  res.render('register', { title: 'Register', error: req.query.error || null });
});

router.post('/register', async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  if (!name || !email || password.length < 8) {
    return res.redirect('/register?error=' + encodeURIComponent('Name, email, and a password of at least 8 characters are required.'));
  }
  if (await findByEmail(email)) {
    return res.redirect('/register?error=' + encodeURIComponent('An account with that email already exists.'));
  }
  // Every self-registration lands as 'student' - promoting someone to
  // instructor/admin is an admin-only action (routes/portal.js's own
  // Manage Members screen), never something a signup form can grant
  // itself.
  const id = await createMember({ name, email, password, role: 'student' });
  req.session.memberId = id;
  res.redirect('/portal');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
