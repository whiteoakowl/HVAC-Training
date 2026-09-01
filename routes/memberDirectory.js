const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const memberDirectory = require('../utils/memberDirectory');

router.use(requireAuth);

function visibleFields(member, fieldSettings) {
  const isVisible = (key) => fieldSettings.find((f) => f.key === key)?.visible;
  const out = { id: member.id, name: member.name, role: member.role };
  if (isVisible('photo')) out.photoUrl = member.photo_path ? `/uploads/photos/${member.photo_path}` : null;
  if (isVisible('phone')) out.phone = member.phone;
  if (isVisible('email')) out.email = member.email;
  return out;
}

router.get('/', async (req, res) => {
  const fieldSettings = await memberDirectory.getFieldSettings();
  const members = await memberDirectory.listDirectoryMembers();
  res.render('member-directory-list', { title: 'Member Directory', members: members.map((m) => visibleFields(m, fieldSettings)) });
});

router.get('/mine', async (req, res) => {
  res.render('member-directory-mine', { title: 'Directory Privacy', optedOut: await memberDirectory.isOptedOut(req.member.id), notice: req.query.notice || null });
});

router.post('/opt-out', async (req, res) => {
  await memberDirectory.setOptedOut(req.member.id, true);
  res.redirect('/member-directory/mine?notice=' + encodeURIComponent('Removed from the directory.'));
});

router.post('/opt-in', async (req, res) => {
  await memberDirectory.setOptedOut(req.member.id, false);
  res.redirect('/member-directory/mine?notice=' + encodeURIComponent('Added back to the directory.'));
});

router.get('/settings', requireRole('admin'), async (req, res) => {
  res.render('member-directory-settings', { title: 'Directory Settings', fieldSettings: await memberDirectory.getFieldSettings(), notice: req.query.notice || null });
});

router.post('/settings', requireRole('admin'), async (req, res) => {
  const visibleKeys = [].concat(req.body.visibleFields || []);
  await memberDirectory.setFieldVisibility(visibleKeys);
  res.redirect('/member-directory/settings?notice=' + encodeURIComponent('Saved.'));
});

router.get('/:id', async (req, res) => {
  const member = await memberDirectory.getDirectoryMember(req.params.id);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  const fieldSettings = await memberDirectory.getFieldSettings();
  res.render('member-directory-detail', { title: member.name, member: visibleFields(member, fieldSettings) });
});

module.exports = router;
