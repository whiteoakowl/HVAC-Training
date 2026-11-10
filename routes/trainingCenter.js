// Training center management: completion matrix, required courses by
// role, renewal sync.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const tc = require('../utils/trainingCenter');
const audit = require('../utils/audit');
const { flash, action } = require('../utils/http');

router.use('/training/center', requireAuth, requirePermission('training.manage', 'employees.view'));

router.get('/training/center', async (req, res) => {
  res.render('training-center', {
    title: 'Training Center', m: await tc.matrix(), reqs: await tc.requirements(), categories: tc.CATEGORIES,
    roles: await db.prepare("SELECT key, name FROM roles WHERE key NOT IN ('customer') ORDER BY position").all(),
    trainings: await db.prepare("SELECT id, title FROM trainings WHERE status = 'published' ORDER BY title").all(),
  });
});

router.post('/training/center/required', requirePermission('training.manage'), action(async (req, res) => {
  const t = await db.prepare("SELECT id FROM trainings WHERE id = ? AND status = 'published'").get(req.body.training_id);
  const r = await db.prepare('SELECT key FROM roles WHERE key = ?').get(req.body.role_key);
  if (!t || !r) throw new Error('Choose a published course and a role.');
  const on = req.body.action !== 'remove';
  await tc.setRequirement(r.key, t.id, req.body.due_days, on);
  await audit.log(req, on ? 'training.required_add' : 'training.required_remove', 'training', t.id, { role: r.key });
  const s = on ? await tc.sync() : null;
  flash(res, '/training/center', 'notice', on ? `Required for ${r.key}. ${s.assigned} new assignment(s).` : 'Requirement removed.');
}, '/training/center'));

router.post('/training/center/sync', requirePermission('training.manage'), action(async (req, res) => {
  const s = await tc.sync();
  await audit.log(req, 'training.sync', null, null, s);
  flash(res, '/training/center', 'notice', `${s.assigned} required course(s) assigned, ${s.renewed} expired certification course(s) re-opened.`);
}, '/training/center'));

module.exports = router;
