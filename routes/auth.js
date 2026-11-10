const express = require('express');
const router = express.Router();
const db = require('../db');
const { findByEmail, verifyPassword, createMember } = require('../utils/auth');
const settings = require('../utils/settings');
const audit = require('../utils/audit');
const fmt = require('../utils/format');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

// Only same-site relative paths ("/x"), never "//evil.example" or
// "/\evil.example", which browsers treat as another host.
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : null;
}

router.get('/login', async (req, res) => {
  if (req.member) return res.redirect(res.locals.homeHref);
  res.render('login', {
    title: 'Log In',
    error: req.query.error || null,
    next: safeNext(req.query.next) || '',
    allowRegistration: await settings.getBool('allow_registration'),
  });
});

router.post('/login', async (req, res) => {
  const next = safeNext(req.body.next);
  const fail = (msg) => res.redirect('/login?error=' + encodeURIComponent(msg) + (next ? '&next=' + encodeURIComponent(next) : ''));
  const member = await findByEmail(req.body.email);
  if (member && member.locked_until && member.locked_until > fmt.nowText()) {
    return fail(`Too many failed attempts. Try again after ${member.locked_until} UTC or ask a manager to reset your password.`);
  }
  if (!member || !(await verifyPassword(member, req.body.password))) {
    if (member) {
      const failed = (member.failed_logins || 0) + 1;
      const lock = failed >= MAX_FAILED ? fmt.nowText(new Date(Date.now() + LOCK_MINUTES * 60000)) : null;
      await db.prepare('UPDATE members SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : failed, lock, member.id);
      await audit.log(req, lock ? 'auth.locked' : 'auth.failed', 'member', member.id);
    }
    return fail('Invalid email or password.');
  }
  if (!member.active) return fail('This account has been deactivated.');
  await db.prepare('UPDATE members SET failed_logins = 0, locked_until = NULL, last_login_at = now_text() WHERE id = ?').run(member.id);
  req.session.memberId = member.id;
  req.member = member;
  await audit.log(req, 'auth.login', 'member', member.id);
  res.redirect(next || '/home');
});

// Self-registration (original feature) creates a 'student' (Trainee)
// account. It can be switched off in Company Settings, which a business
// running employee/customer data through this app usually should do.
router.get('/register', async (req, res) => {
  if (req.member) return res.redirect(res.locals.homeHref);
  if (!(await settings.getBool('allow_registration'))) return res.redirect('/login?error=' + encodeURIComponent('Self-registration is turned off. Ask a manager for an account.'));
  res.render('register', { title: 'Register', error: req.query.error || null });
});

router.post('/register', async (req, res) => {
  if (!(await settings.getBool('allow_registration'))) return res.redirect('/login');
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  if (!name || !email || password.length < 8) {
    return res.redirect('/register?error=' + encodeURIComponent('Name, email, and a password of at least 8 characters are required.'));
  }
  if (await findByEmail(email)) {
    return res.redirect('/register?error=' + encodeURIComponent('An account with that email already exists.'));
  }
  // Every self-registration lands as 'student' - granting any other role
  // is done by a manager under Users & Roles, never by a signup form.
  const id = await createMember({ name, email, password, role: 'student' });
  req.session.memberId = id;
  await audit.log({ ...req, member: { id } }, 'auth.register', 'member', id);
  res.redirect('/home');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
module.exports.safeNext = safeNext;
