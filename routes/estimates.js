// Estimates / proposals (staff side). The customer-facing approval page
// lives in routes/public.js (/e/:token).
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const estimates = require('../utils/estimates');
const customers = require('../utils/customers');
const inventory = require('../utils/inventory');
const invoices = require('../utils/invoices');
const settings = require('../utils/settings');
const messaging = require('../utils/messaging');
const automation = require('../utils/automation');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

router.use(requireAuth, requirePermission('estimates.view', 'estimates.manage'));

router.get('/', async (req, res) => {
  const status = estimates.STATUSES.includes(req.query.status) ? req.query.status : null;
  const open = !status && req.query.all !== '1';
  const rows = await estimates.list({ status, open, q: req.query.q || null });
  const all = await estimates.list({ limit: 2000 });
  const decided = all.filter((e) => ['approved', 'converted', 'rejected', 'expired'].includes(e.status));
  const won = decided.filter((e) => ['approved', 'converted'].includes(e.status));
  res.render('estimates-list', {
    title: 'Estimates', rows, status, open, q: req.query.q || '', statuses: estimates.STATUSES,
    stats: {
      pending: all.filter((e) => e.status === 'sent').length, pendingValue: all.filter((e) => e.status === 'sent').reduce((s, e) => s + e.total_cents, 0),
      approved: won.length, approvedValue: won.reduce((s, e) => s + e.total_cents, 0), conversion: decided.length ? Math.round((won.length / decided.length) * 100) : null,
    },
  });
});

router.get('/new', requirePermission('estimates.manage'), async (req, res) => {
  const customer = req.query.customer_id ? await customers.get(req.query.customer_id) : null;
  const results = !customer && req.query.q ? await customers.search(req.query.q, { limit: 20 }) : [];
  res.render('estimates-new', { title: 'New Estimate', customer, results, q: req.query.q || '', properties: customer ? await customers.properties(customer.id) : [], requestId: req.query.request_id || '' });
});

router.post('/new', requirePermission('estimates.manage'), action(async (req, res) => {
  const c = await customers.get(req.body.customer_id);
  if (!c) throw new Error('Choose a customer.');
  const p = req.body.property_id ? await customers.getProperty(req.body.property_id) : null;
  if (p && p.customer_id !== c.id) throw new Error('That property belongs to another customer.');
  const id = await estimates.create({ ...req.body, customer_id: c.id, property_id: p ? p.id : null, service_request_id: req.body.service_request_id || null }, req.member.id);
  await audit.log(req, 'estimate.create', 'estimate', id);
  flash(res, `/estimates/${id}`, 'notice', 'Estimate created. Add equipment, materials and labor below.');
}, (req) => `/estimates/new?customer_id=${encodeURIComponent(req.body.customer_id || '')}`));

async function load(req, res, next) {
  const e = await estimates.details(req.params.id);
  if (!e) return res.status(404).render('404', { title: 'Not Found' });
  req.est = e;
  next();
}
const back = (req) => `/estimates/${req.params.id}`;

router.get('/:id', load, async (req, res) => {
  res.render('estimate', {
    title: req.est.estimate_number, e: req.est, company: await settings.all(), kinds: estimates.KINDS, items: await inventory.listItems(),
    properties: await customers.properties(req.est.customer_id), print: req.query.print === '1',
  });
});

router.post('/:id/edit', requirePermission('estimates.manage'), load, action(async (req, res) => {
  const p = req.body.property_id ? await customers.getProperty(req.body.property_id) : null;
  if (p && p.customer_id !== req.est.customer_id) throw new Error('That property belongs to another customer.');
  await estimates.update(req.est.id, { ...req.body, property_id: p ? p.id : null });
  await audit.log(req, 'estimate.update', 'estimate', req.est.id);
  flash(res, back(req), 'notice', 'Saved.');
}, back));

router.post('/:id/lines', requirePermission('estimates.manage'), load, action(async (req, res) => {
  const price = req.body.unit_price === '' || req.body.unit_price === undefined ? null : fmt.toCents(req.body.unit_price);
  await estimates.addLine(req.est.id, { kind: req.body.kind, itemId: parseInt(req.body.item_id, 10) || null, description: req.body.description, quantity: fmt.toNumber(req.body.quantity), unitPriceCents: price, taxable: req.body.taxable === '1' });
  flash(res, back(req) + '#lines', 'notice', 'Line added.');
}, back));

router.post('/:id/lines/:lineId/delete', requirePermission('estimates.manage'), load, action(async (req, res) => {
  await estimates.removeLine(req.est.id, req.params.lineId);
  flash(res, back(req) + '#lines', 'notice', 'Line removed.');
}, back));

router.post('/:id/send', requirePermission('estimates.manage'), load, action(async (req, res) => {
  await estimates.markSent(req.est.id);
  const e = await estimates.details(req.est.id);
  const link = `${req.protocol}://${req.get('host')}/e/${e.public_token}`;
  const company = await settings.get('company_name', 'Our team');
  const body = `${company} sent you estimate ${e.estimate_number} for "${e.title}": ${fmt.money(e.total_cents)}. Review and approve online: ${link} (valid until ${fmt.d(e.expires_on)}).`;
  const results = [];
  if (req.body.channel !== 'sms' && e.customerEmail) results.push(await messaging.send({ channel: 'email', to: e.customerEmail, subject: `Estimate ${e.estimate_number} from ${company}`, body, relatedType: 'estimate', relatedId: e.id }));
  if (req.body.channel === 'sms' || req.body.channel === 'both') if (e.customerPhone) results.push(await messaging.send({ channel: 'sms', to: e.customerPhone, body, relatedType: 'estimate', relatedId: e.id }));
  await customers.addInteraction(e.customer_id, { channel: req.body.channel === 'sms' ? 'sms' : 'email', direction: 'outbound', summary: `Estimate ${e.estimate_number} sent (${results.map((r) => r.status).join(', ') || 'marked sent; link shared manually'})` }, req.member.id);
  await audit.log(req, 'estimate.send', 'estimate', e.id, { results: results.map((r) => r.status) });
  const delivered = results.some((r) => r.status === 'sent');
  flash(res, back(req), delivered || !results.length ? 'notice' : 'error', delivered ? 'Estimate sent to the customer.' : results.length ? 'Marked as sent, but no email/SMS provider is configured. Copy the customer link below and share it.' : 'Marked as sent. Copy the customer link below and share it.');
}, back));

async function afterApproval(req, estimateId) {
  await automation.notifyPermission(['estimates.manage'], 'job_status', { title: `Estimate approved: ${req.est.estimate_number}`, body: `${req.est.customerName} - ${fmt.money(req.est.total_cents)}`, linkUrl: `/estimates/${estimateId}` }, req.member ? req.member.id : null);
  await automation.run('automation_job_from_approved_estimate', 'estimate', estimateId, async () => {
    const jobId = await estimates.convertToJob(estimateId, req.member ? req.member.id : null);
    await automation.notifyPermission(['jobs.dispatch', 'jobs.manage'], 'job_status', { title: `New job ready to schedule from ${req.est.estimate_number}`, linkUrl: `/jobs/${jobId}` });
    return `job #${jobId}`;
  });
}

router.post('/:id/decision', requirePermission('estimates.manage'), load, action(async (req, res) => {
  const approve = req.body.decision === 'approve';
  await estimates.decide(req.est.id, { approve, name: req.body.approved_name, reason: req.body.reason });
  await audit.log(req, approve ? 'estimate.approved_by_office' : 'estimate.rejected_by_office', 'estimate', req.est.id, { name: req.body.approved_name, reason: req.body.reason });
  if (approve) await afterApproval(req, req.est.id);
  flash(res, back(req), 'notice', approve ? 'Approval recorded.' : 'Marked as declined.');
}, back));

router.post('/:id/revise', requirePermission('estimates.manage'), load, action(async (req, res) => {
  const id = await estimates.revise(req.est.id, req.member.id);
  await audit.log(req, 'estimate.revise', 'estimate', req.est.id, { newId: id });
  flash(res, `/estimates/${id}`, 'notice', 'Revision created. The previous version is marked superseded.');
}, back));

router.post('/:id/convert', requirePermission('jobs.manage'), load, action(async (req, res) => {
  const jobId = await estimates.convertToJob(req.est.id, req.member.id);
  await audit.log(req, 'estimate.convert', 'estimate', req.est.id, { jobId });
  flash(res, `/jobs/${jobId}`, 'notice', 'Job created from the estimate.');
}, back));

router.post('/:id/deposit', requirePermission('invoices.manage'), load, action(async (req, res) => {
  const { id, created } = await invoices.createDeposit(req.est.id, req.member.id);
  if (created) await audit.log(req, 'invoice.deposit', 'invoice', id, { estimateId: req.est.id });
  flash(res, `/invoices/${id}`, 'notice', created ? 'Deposit invoice drafted. Issue it to bill the customer.' : 'A deposit invoice already exists.');
}, back));

module.exports = router;
module.exports.afterApproval = afterApproval;
