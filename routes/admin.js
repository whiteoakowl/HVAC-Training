// Administration: role permission matrix, company settings, audit log,
// automation history and the outbound message log.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const settings = require('../utils/settings');
const audit = require('../utils/audit');
const automation = require('../utils/automation');
const messaging = require('../utils/messaging');
const fmt = require('../utils/format');
const { flash, action, asArray } = require('../utils/http');

router.use(requireAuth);

router.get('/roles', requirePermission('roles.manage'), async (req, res) => {
  const roles = await permissions.listRoles();
  const perms = await permissions.listPermissions();
  const grants = {};
  for (const r of roles) grants[r.key] = await permissions.permissionsForRole(r.key);
  const modules = [...new Set(perms.map((p) => p.module))];
  res.render('admin-roles', { title: 'Role Permissions', roles, perms, grants, modules });
});

router.post('/roles/:key', requirePermission('roles.manage'), action(async (req, res) => {
  const role = await permissions.getRole(req.params.key);
  if (!role) throw new Error('Role not found.');
  if (role.key === 'admin') throw new Error('The Owner role always has full access and cannot be edited.');
  let keys = asArray(req.body.permissions);
  // Only an owner can hand out owner-level powers.
  if (!req.can('system.admin')) keys = keys.filter((k) => !['system.admin', 'roles.manage'].includes(k));
  if (role.key === req.member.role && !keys.includes('roles.manage') && !req.can('system.admin')) throw new Error("You can't remove role management from your own role.");
  const before = [...(await permissions.permissionsForRole(role.key))];
  await permissions.setRolePermissions(role.key, keys);
  await audit.log(req, 'role.permissions', 'role', role.key, { added: keys.filter((k) => !before.includes(k)), removed: before.filter((k) => !keys.includes(k)) });
  flash(res, `/admin/roles#role-${role.key}`, 'notice', `Saved permissions for ${role.name}.`);
}, '/admin/roles'));

const SETTING_FIELDS = [
  ['company_timezone', 'timezone'], ['company_name', 'text'], ['company_phone', 'text'], ['company_email', 'text'], ['company_address', 'text'],
  ['labor_rate_cents', 'money'], ['default_tax_rate_bp', 'percent'], ['invoice_terms_days', 'int'], ['invoice_footer', 'text'], ['invoice_payment_instructions', 'text'],
  ['overtime_weekly_hours', 'int'], ['pto_hours_per_day', 'int'], ['estimate_valid_days', 'int'], ['estimate_terms', 'text'], ['estimate_warranty', 'text'], ['maintenance_job_lead_days', 'int'], ['gps_clock_enabled', 'bool'], ['allow_registration', 'bool'],
  ...Object.keys(automation.RULES).map((k) => [k, 'bool']),
];

router.get('/settings', requirePermission('settings.manage'), async (req, res) => {
  res.render('admin-settings', {
    title: 'Company Settings', s: await settings.all(), rules: automation.RULES,
    integrations: { email: messaging.emailConfigured(), sms: messaging.smsConfigured(), wix: Boolean(process.env.WIX_WEBHOOK_SECRET), sessionSecret: Boolean(process.env.SESSION_SECRET), database: Boolean(require('../db/config').postgresUrl) },
  });
});

router.post('/settings', requirePermission('settings.manage'), action(async (req, res) => {
  const changed = [];
  for (const [key, type] of SETTING_FIELDS) {
    let v = req.body[key];
    if (type === 'bool') v = v === '1' ? '1' : '0';
    else if (type === 'money') {
      const c = fmt.toCents(v);
      if (c === null || c < 0) throw new Error('Labor rate must be a positive amount.');
      v = String(c);
    } else if (type === 'percent') {
      const n = fmt.toNumber(v);
      if (n === null || n < 0 || n > 50) throw new Error('Tax rate must be between 0 and 50%.');
      v = String(Math.round(n * 100));
    } else if (type === 'int') {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || n > 365) throw new Error('Whole numbers only (0-365).');
      v = String(n);
    } else if (type === 'timezone') {
      v = String(v || '').trim();
      if (!fmt.validTimezone(v)) throw new Error('Timezone must be an IANA name such as America/Chicago.');
    } else v = fmt.clean(v, 2000) || '';
    if ((await settings.get(key, null)) !== v) changed.push(key);
    await settings.set(key, v);
  }
  await audit.log(req, 'settings.update', 'settings', null, { changed });
  if (changed.includes('company_timezone')) await settings.applyTimezone(true);
  flash(res, '/admin/settings', 'notice', 'Settings saved.');
}, '/admin/settings'));

router.get('/audit', requirePermission('audit.view'), async (req, res) => {
  res.render('admin-audit', {
    title: 'Audit & Automation', rows: await audit.list({ entityType: req.query.entity || null, entityId: req.query.id || null, limit: 500 }),
    runs: await automation.history(200), messages: await messaging.list(200), entity: req.query.entity || '', id: req.query.id || '',
  });
});

router.post('/run-daily', requirePermission('audit.view'), requirePermission('settings.manage'), action(async (req, res) => {
  const r = await require('../utils/scheduler').runDaily({ force: true, origin: `manual by ${req.member.name}` });
  await audit.log(req, 'automation.daily_run', null, null, r.results);
  flash(res, '/admin/audit', 'notice', 'Daily automations ran: ' + Object.entries(r.results).map(([k, v]) => `${k.replace('automation_', '')}: ${v === null ? 'off' : v}`).join(' | '));
}, '/admin/audit'));

// Service checklist / inspection form templates.
router.get('/checklists', requirePermission('checklists.manage'), async (req, res) => {
  const db = require('../db');
  res.render('admin-checklists', { title: 'Checklists & Inspection Forms', rows: await db.prepare('SELECT * FROM checklist_templates ORDER BY active DESC, name').all() });
});

router.post('/checklists', requirePermission('checklists.manage'), action(async (req, res) => {
  const db = require('../db');
  const name = fmt.clean(req.body.name, 100);
  const items = String(req.body.items || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 80).join('\n');
  if (!name || !items) throw new Error('Name and at least one item are required.');
  const id = parseInt(req.body.id, 10);
  const dup = await db.prepare('SELECT id FROM checklist_templates WHERE LOWER(name) = LOWER(?) AND id <> ?').get(name, id || 0);
  if (dup) throw new Error('A checklist with that name exists.');
  if (id) await db.prepare('UPDATE checklist_templates SET name = ?, items = ?, active = ? WHERE id = ?').run(name, items, req.body.active === '0' ? 0 : 1, id);
  else await db.prepare('INSERT INTO checklist_templates (name, items) VALUES (?, ?)').run(name, items);
  await audit.log(req, 'checklist.save', 'checklist_template', id || null, { name });
  flash(res, '/admin/checklists', 'notice', 'Saved.');
}, '/admin/checklists'));

module.exports = router;
