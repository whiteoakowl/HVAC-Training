// Maintenance plans and agreements.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const agreements = require('../utils/agreements');
const customers = require('../utils/customers');
const invoices = require('../utils/invoices');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

router.use(requireAuth, requirePermission('agreements.manage', 'invoices.manage'));
const manage = requirePermission('agreements.manage');

router.get('/', async (req, res) => {
  const status = ['active', 'expired', 'cancelled', 'renewed'].includes(req.query.status) ? req.query.status : 'active';
  const rows = await agreements.list({ status });
  const active = await agreements.list({ status: 'active' });
  res.render('agreements-list', {
    title: 'Maintenance Agreements', rows, status, plans: await agreements.listPlans(), today: fmt.today(),
    stats: { active: active.length, annualValue: active.reduce((s, a) => s + a.price_cents, 0), dueSoon: (await agreements.visitsComingDue(30)).length, ending: (await agreements.endingWithin(30)).length },
  });
});

router.post('/plans', manage, action(async (req, res) => {
  await agreements.savePlan(parseInt(req.body.id, 10) || null, req.body);
  await audit.log(req, 'plan.save', 'maintenance_plan', req.body.id || null, { name: req.body.name });
  flash(res, '/agreements#plans', 'notice', 'Plan saved.');
}, '/agreements'));

router.get('/new', manage, async (req, res) => {
  const c = await customers.get(req.query.customer_id);
  if (!c) return flash(res, '/customers', 'error', 'Open a customer and choose "+ Maintenance agreement".');
  const props = await customers.properties(c.id);
  const equipment = await customers.equipmentForCustomer(c.id);
  res.render('agreements-new', { title: 'New Maintenance Agreement', c, props, equipment, plans: await agreements.listPlans({ activeOnly: true }), today: fmt.today() });
});

router.post('/new', manage, action(async (req, res) => {
  const id = await agreements.create(req.body, req.member.id);
  await audit.log(req, 'agreement.create', 'agreement', id);
  flash(res, `/agreements/${id}`, 'notice', 'Agreement created with its visit schedule.');
}, (req) => `/agreements/new?customer_id=${encodeURIComponent(req.body.customer_id || '')}`));

async function load(req, res, next) {
  const a = await agreements.get(req.params.id);
  if (!a) return res.status(404).render('404', { title: 'Not Found' });
  req.ag = a;
  next();
}
const back = (req) => `/agreements/${req.params.id}`;

router.get('/:id', load, (req, res) => res.render('agreement', { title: req.ag.agreement_number, a: req.ag, today: fmt.today() }));

router.post('/:id/visits/:vid/job', requirePermission('jobs.manage'), load, action(async (req, res) => {
  const v = req.ag.visits.find((x) => String(x.id) === req.params.vid);
  if (!v) throw new Error('Visit not found.');
  const jobId = await agreements.createVisitJob(v.id, req.member.id);
  await audit.log(req, 'agreement.visit_job', 'agreement', req.ag.id, { visitId: v.id, jobId });
  flash(res, `/jobs/${jobId}`, 'notice', 'Maintenance job created - assign a technician and schedule it.');
}, back));

router.post('/:id/visits/:vid/skip', manage, load, action(async (req, res) => {
  await db.prepare("UPDATE agreement_visits SET status = 'skipped' WHERE id = ? AND agreement_id = ? AND status = 'due'").run(req.params.vid, req.ag.id);
  await audit.log(req, 'agreement.visit_skip', 'agreement', req.ag.id, { visitId: req.params.vid });
  flash(res, back(req), 'notice', 'Visit skipped.');
}, back));

router.post('/:id/invoice', requirePermission('invoices.manage'), load, action(async (req, res) => {
  const { id, created } = await invoices.createForAgreement(req.ag.id, req.member.id);
  if (created) await audit.log(req, 'invoice.create', 'invoice', id, { agreementId: req.ag.id });
  flash(res, `/invoices/${id}`, 'notice', created ? 'Draft agreement invoice created.' : 'This agreement already has an invoice.');
}, back));

router.post('/:id/renew', manage, load, action(async (req, res) => {
  const id = await agreements.renew(req.ag.id, req.member.id);
  await audit.log(req, 'agreement.renew', 'agreement', req.ag.id, { newId: id });
  flash(res, `/agreements/${id}`, 'notice', 'Renewed. Create the renewal invoice from this page.');
}, back));

router.post('/:id/cancel', manage, load, action(async (req, res) => {
  await agreements.cancel(req.ag.id, req.body.reason);
  await audit.log(req, 'agreement.cancel', 'agreement', req.ag.id, { reason: req.body.reason });
  flash(res, back(req), 'notice', 'Agreement cancelled; remaining visits skipped.');
}, back));

router.post('/:id/auto-renew', manage, load, action(async (req, res) => {
  await db.prepare('UPDATE maintenance_agreements SET auto_renew = ? WHERE id = ?').run(req.body.auto_renew === '1' ? 1 : 0, req.ag.id);
  flash(res, back(req), 'notice', 'Saved.');
}, back));

module.exports = router;
