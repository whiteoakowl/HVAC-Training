// Pages that work without logging in:
//   /e/:token   customer reviews, signs and approves (or declines) an estimate
//   /i/:token   customer views an invoice
//   /forgot, /reset/:token   password reset by email
// Tokens are 48 random hex characters; nothing else about the record is
// guessable or listed.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const estimates = require('../utils/estimates');
const invoices = require('../utils/invoices');
const settings = require('../utils/settings');
const messaging = require('../utils/messaging');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { findByEmail, hashPassword } = require('../utils/auth');
const { afterApproval } = require('./estimates');

function flashTo(res, url, type, msg) {
  res.redirect(`${url}?${type}=${encodeURIComponent(msg)}`);
}

router.get('/e/:token', async (req, res) => {
  const e = await estimates.byToken(req.params.token);
  if (!e || e.status === 'draft') return res.status(404).render('404', { title: 'Not Found' });
  if (e.status === 'superseded') {
    const newer = await db.prepare("SELECT public_token FROM estimates WHERE (parent_estimate_id = ? OR parent_estimate_id = ?) AND status NOT IN ('draft','superseded') ORDER BY revision DESC LIMIT 1").get(e.parent_estimate_id || e.id, e.id);
    if (newer) return res.redirect(`/e/${newer.public_token}`);
  }
  res.render('public-estimate', { title: `Estimate ${e.estimate_number}`, e, company: await settings.all(), expired: e.status === 'sent' && e.expires_on && e.expires_on < fmt.today() });
});

router.post('/e/:token', async (req, res) => {
  const e = await estimates.byToken(req.params.token);
  if (!e) return res.status(404).render('404', { title: 'Not Found' });
  const approve = req.body.decision === 'approve';
  try {
    if (approve && req.body.agree !== '1') throw new Error('Please confirm you agree to the terms.');
    await estimates.decide(e.id, { approve, name: req.body.name, signatureData: req.body.signature_data, reason: req.body.reason });
    await audit.log({ headers: req.headers, ip: req.ip }, approve ? 'estimate.approved_by_customer' : 'estimate.rejected_by_customer', 'estimate', e.id, { name: req.body.name });
    if (approve) await afterApproval({ est: e, member: null }, e.id);
    else {
      const automation = require('../utils/automation');
      await automation.notifyPermission(['estimates.manage'], 'job_status', { title: `Estimate declined: ${e.estimate_number}`, body: fmt.clean(req.body.reason, 200) || '', linkUrl: `/estimates/${e.id}` });
    }
    flashTo(res, `/e/${req.params.token}`, 'notice', approve ? 'Thank you! Your approval has been received. We will contact you to schedule.' : 'Thanks for letting us know.');
  } catch (err) {
    flashTo(res, `/e/${req.params.token}`, 'error', err.code ? 'Something went wrong. Please call us.' : err.message);
  }
});

router.get('/i/:token', async (req, res) => {
  const inv = await invoices.byToken(req.params.token);
  if (!inv || ['draft', 'void'].includes(inv.status)) return res.status(404).render('404', { title: 'Not Found' });
  res.render('public-invoice', { title: `Invoice ${inv.invoice_number}`, inv, company: await settings.all() });
});

// ---------------------------------------------------------------- password reset
router.get('/forgot', (req, res) => res.render('forgot', { title: 'Reset password', emailReady: messaging.emailConfigured() }));

router.post('/forgot', async (req, res) => {
  const generic = 'If that email belongs to an active account, a reset link has been sent. It expires in 1 hour.';
  if (!messaging.emailConfigured()) return flashTo(res, '/forgot', 'error', 'Password reset by email is not set up yet. Ask a manager to reset your password.');
  const member = await findByEmail(req.body.email);
  if (member && member.active) {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await db.prepare('INSERT INTO password_resets (token_hash, member_id, expires_at) VALUES (?, ?, ?)').run(hash, member.id, fmt.nowText(new Date(Date.now() + 3600e3)));
    const link = `${req.protocol}://${req.get('host')}/reset/${token}`;
    await messaging.send({ channel: 'email', to: member.email, subject: 'Reset your password', body: `Use this link within 1 hour to set a new password: ${link}\nIf you didn't ask for this, ignore this email.`, relatedType: 'member', relatedId: member.id });
    await audit.log({ headers: req.headers, ip: req.ip }, 'auth.reset_requested', 'member', member.id);
  }
  flashTo(res, '/login', 'notice', generic);
});

async function resetRow(token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(hash, fmt.nowText());
}

router.get('/reset/:token', async (req, res) => {
  if (!(await resetRow(req.params.token))) return flashTo(res, '/login', 'error', 'That reset link is invalid or has expired.');
  res.render('reset', { title: 'Set a new password', token: req.params.token });
});

router.post('/reset/:token', async (req, res) => {
  const row = await resetRow(req.params.token);
  if (!row) return flashTo(res, '/login', 'error', 'That reset link is invalid or has expired.');
  const pw = req.body.password || '';
  if (pw.length < 10) return flashTo(res, `/reset/${req.params.token}`, 'error', 'Use at least 10 characters.');
  if (pw !== req.body.confirm) return flashTo(res, `/reset/${req.params.token}`, 'error', "Passwords don't match.");
  await db.withTransaction(async (tx) => {
    await tx.prepare('UPDATE members SET password_hash = ?, failed_logins = 0, locked_until = NULL, must_change_password = 0 WHERE id = ?').run(hashPassword(pw), row.member_id);
    await tx.prepare('UPDATE password_resets SET used_at = now_text() WHERE member_id = ? AND used_at IS NULL').run(row.member_id);
  });
  await audit.log({ headers: req.headers, ip: req.ip, member: { id: row.member_id } }, 'auth.reset_completed', 'member', row.member_id);
  flashTo(res, '/login', 'notice', 'Password updated. You can log in now.');
});

module.exports = router;
