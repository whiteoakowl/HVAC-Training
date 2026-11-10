// My Account: change password, two-step verification (TOTP).
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const mfa = require('../utils/mfa');
const settings = require('../utils/settings');
const audit = require('../utils/audit');
const { verifyPassword, hashPassword } = require('../utils/auth');
const { flash, action } = require('../utils/http');

router.use(requireAuth);

router.get('/', async (req, res) => {
  let setup = null;
  if (!req.member.mfa_enabled && req.session.mfaSetup) {
    const issuer = await settings.get('company_name', 'HVAC Portal');
    setup = { secret: req.session.mfaSetup, uri: mfa.otpauthUri(req.session.mfaSetup, req.member.email, issuer) };
  }
  res.render('account', { title: 'My Account', setup });
});

router.post('/password', action(async (req, res) => {
  if (!(await verifyPassword(req.member, req.body.current))) throw new Error('Your current password is not correct.');
  const pw = req.body.password || '';
  if (pw.length < 10) throw new Error('Use at least 10 characters.');
  if (pw !== req.body.confirm) throw new Error("New passwords don't match.");
  await db.prepare('UPDATE members SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(pw), req.member.id);
  await audit.log(req, 'auth.password_changed', 'member', req.member.id);
  flash(res, '/account', 'notice', 'Password changed.');
}, '/account'));

router.post('/mfa/start', action(async (req, res) => {
  if (req.member.mfa_enabled) throw new Error('Two-step verification is already on.');
  req.session.mfaSetup = mfa.generateSecret();
  res.redirect('/account#mfa');
}, '/account'));

router.post('/mfa/confirm', action(async (req, res) => {
  const secret = req.session.mfaSetup;
  if (!secret) throw new Error('Start the setup again.');
  if (!mfa.verify(secret, req.body.code)) throw new Error('That code did not match. Check the time on your phone and try the current code.');
  await db.prepare('UPDATE members SET mfa_secret = ?, mfa_enabled = 1 WHERE id = ?').run(secret, req.member.id);
  req.session.mfaSetup = null;
  await audit.log(req, 'auth.mfa_enabled', 'member', req.member.id);
  flash(res, '/account', 'notice', 'Two-step verification is on. You will be asked for a code each time you log in.');
}, '/account'));

router.post('/mfa/disable', action(async (req, res) => {
  if (!req.member.mfa_enabled) throw new Error('Two-step verification is not on.');
  if (!mfa.verify(req.member.mfa_secret, req.body.code)) throw new Error('Enter a current code from your app to turn this off.');
  await db.prepare('UPDATE members SET mfa_secret = NULL, mfa_enabled = 0 WHERE id = ?').run(req.member.id);
  await audit.log(req, 'auth.mfa_disabled', 'member', req.member.id);
  flash(res, '/account', 'notice', 'Two-step verification is off.');
}, '/account'));

module.exports = router;
