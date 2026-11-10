// CRM: customers, properties, equipment and the communication log.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const customers = require('../utils/customers');
const jobs = require('../utils/jobs');
const invoices = require('../utils/invoices');
const serviceRequests = require('../utils/serviceRequests');
const audit = require('../utils/audit');
const db = require('../db');
const { flash, action } = require('../utils/http');

router.use(requireAuth, requirePermission('customers.view'));

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  res.render('customers-list', { title: 'Customers', q, rows: await customers.search(q) });
});

router.get('/new', requirePermission('customers.edit'), (req, res) => {
  res.render('customers-form', { title: 'New Customer', customer: {}, isNew: true });
});

router.post('/new', requirePermission('customers.edit'), action(async (req, res) => {
  const dup = await customers.findMatch(req.body);
  if (dup && req.body.confirm_duplicate !== '1') {
    return flash(res, `/customers/${dup.id}`, 'error', `${dup.name} (${dup.customer_number}) already has that email or phone. Use this record, or add the new one from the form with "create anyway" checked.`);
  }
  const id = await customers.create(req.body, req.member.id);
  if (req.body.address) await customers.addProperty(id, { ...req.body, label: 'Primary' });
  await audit.log(req, 'customer.create', 'customer', id);
  flash(res, `/customers/${id}`, 'notice', 'Customer created.');
}, '/customers/new'));

async function load(req, res, next) {
  const customer = await customers.get(req.params.id);
  if (!customer) return res.status(404).render('404', { title: 'Not Found' });
  req.customer = customer;
  next();
}

router.get('/:id', load, async (req, res) => {
  const c = req.customer;
  const [properties, equipment, interactions, jobList, invoiceList, requests, balance, payments] = await Promise.all([
    customers.properties(c.id), customers.equipmentForCustomer(c.id), customers.interactions(c.id), jobs.list({ customerId: c.id, limit: 500 }),
    req.can('invoices.view', 'invoices.manage') ? invoices.list({ customerId: c.id }) : [], serviceRequests.list({ customerId: c.id }), customers.balance(c.id),
    req.can('invoices.view', 'invoices.manage') ? db.prepare('SELECT p.*, i.invoice_number FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.customer_id = ? ORDER BY p.id DESC').all(c.id) : [],
  ]);
  const photos = await db.prepare('SELECT f.id, f.caption, f.job_id, j.job_number FROM job_files f JOIN jobs j ON j.id = f.job_id WHERE j.customer_id = ? AND f.kind = \'photo\' ORDER BY f.id DESC LIMIT 24').all(c.id);
  res.render('customers-detail', { title: c.name, c, properties, equipment, interactions, jobList, invoiceList, requests, balance, payments, photos, channels: customers.CHANNELS });
});

router.get('/:id/edit', requirePermission('customers.edit'), load, (req, res) => {
  res.render('customers-form', { title: `Edit ${req.customer.name}`, customer: req.customer, isNew: false });
});

router.post('/:id/edit', requirePermission('customers.edit'), load, action(async (req, res) => {
  await customers.update(req.customer.id, req.body);
  await audit.log(req, 'customer.update', 'customer', req.customer.id);
  flash(res, `/customers/${req.customer.id}`, 'notice', 'Saved.');
}, (req) => `/customers/${req.params.id}/edit`));

router.post('/:id/properties', requirePermission('customers.edit'), load, action(async (req, res) => {
  const id = await customers.addProperty(req.customer.id, req.body);
  await audit.log(req, 'property.create', 'property', id, { customerId: req.customer.id });
  flash(res, `/customers/${req.customer.id}#properties`, 'notice', 'Property added.');
}, (req) => `/customers/${req.params.id}`));

router.post('/:id/properties/:pid/edit', requirePermission('customers.edit'), load, action(async (req, res) => {
  const p = await customers.getProperty(req.params.pid);
  if (!p || p.customer_id !== req.customer.id) throw new Error('Property not found.');
  await customers.updateProperty(p.id, req.body);
  await audit.log(req, 'property.update', 'property', p.id);
  flash(res, `/customers/${req.customer.id}#properties`, 'notice', 'Property updated.');
}, (req) => `/customers/${req.params.id}`));

router.post('/:id/equipment', requirePermission('customers.edit'), load, action(async (req, res) => {
  const p = await customers.getProperty(req.body.property_id);
  if (!p || p.customer_id !== req.customer.id) throw new Error('Choose one of this customer\'s properties.');
  const id = await customers.addEquipment(p.id, req.body);
  await audit.log(req, 'equipment.create', 'equipment', id, { customerId: req.customer.id });
  flash(res, `/customers/${req.customer.id}#equipment`, 'notice', 'Equipment added.');
}, (req) => `/customers/${req.params.id}`));

router.get('/:id/equipment/:eid', load, async (req, res) => {
  const e = await customers.getEquipment(req.params.eid);
  if (!e || e.customer_id !== req.customer.id) return res.status(404).render('404', { title: 'Not Found' });
  const history = await db
    .prepare('SELECT j.id, j.job_number, j.title, j.status, j.completed_at, j.work_performed FROM job_equipment je JOIN jobs j ON j.id = je.job_id WHERE je.equipment_id = ? ORDER BY j.id DESC')
    .all(e.id);
  res.render('equipment-detail', { title: `${e.equipment_type} - ${req.customer.name}`, c: req.customer, e, history, properties: await customers.properties(req.customer.id) });
});

router.post('/:id/equipment/:eid/edit', requirePermission('customers.edit'), load, action(async (req, res) => {
  const e = await customers.getEquipment(req.params.eid);
  if (!e || e.customer_id !== req.customer.id) throw new Error('Equipment not found.');
  await customers.updateEquipment(e.id, req.body);
  await audit.log(req, 'equipment.update', 'equipment', e.id);
  flash(res, `/customers/${req.customer.id}/equipment/${e.id}`, 'notice', 'Equipment updated.');
}, (req) => `/customers/${req.params.id}/equipment/${req.params.eid}`));

router.post('/:id/interactions', requirePermission('customers.edit'), load, action(async (req, res) => {
  await customers.addInteraction(req.customer.id, req.body, req.member.id);
  flash(res, `/customers/${req.customer.id}#communication`, 'notice', 'Logged.');
}, (req) => `/customers/${req.params.id}`));

router.post('/:id/interactions/:iid/done', requirePermission('customers.edit'), load, action(async (req, res) => {
  await db.prepare('UPDATE customer_interactions SET follow_up_done = 1 WHERE id = ? AND customer_id = ?').run(req.params.iid, req.customer.id);
  flash(res, req.body.back === 'service' ? '/service' : `/customers/${req.customer.id}#communication`, 'notice', 'Follow-up marked done.');
}, (req) => `/customers/${req.params.id}`));

module.exports = router;
