// Customer self-service portal (/my). A customer login (role 'customer')
// is linked to exactly one customer record via customers.member_id and
// can only ever see that record's data.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const customers = require('../utils/customers');
const serviceRequests = require('../utils/serviceRequests');
const messaging = require('../utils/messaging');
const settings = require('../utils/settings');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { findByEmail, createMember } = require('../utils/auth');
const { flash, action } = require('../utils/http');

// ---------------------------------------------------------------- staff: invite a customer
router.post('/customers/:id/portal-invite', requireAuth, requirePermission('customers.edit'), action(async (req, res) => {
  const c = await customers.get(req.params.id);
  if (!c) throw new Error('Customer not found.');
  if (c.member_id) throw new Error('This customer already has a portal login.');
  if (!c.email) throw new Error('Add an email address to the customer first.');
  if (await findByEmail(c.email)) throw new Error('That email already belongs to a user account.');
  const temp = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, 'x') + '7a!';
  const memberId = await createMember({ name: c.name, email: c.email, password: temp, role: 'customer' });
  await db.prepare('UPDATE members SET must_change_password = 1, phone = ? WHERE id = ?').run(c.phone, memberId);
  await db.prepare('UPDATE customers SET member_id = ? WHERE id = ?').run(memberId, c.id);
  const company = await settings.get('company_name', 'Our team');
  const link = `${req.protocol}://${req.get('host')}/login`;
  const sent = await messaging.send({ channel: 'email', to: c.email, subject: `Your ${company} customer portal`, body: `You can now view your service history, estimates and invoices and request service online.\nLog in at ${link}\nEmail: ${c.email}\nTemporary password: ${temp}\nYou'll be asked to choose your own password.`, relatedType: 'customer', relatedId: c.id });
  await customers.addInteraction(c.id, { channel: 'email', direction: 'outbound', summary: `Customer portal invitation (${sent.status})` }, req.member.id);
  await audit.log(req, 'customer.portal_invite', 'customer', c.id, { memberId, emailed: sent.status });
  res.render('customer-invite', { title: 'Portal access created', c, temp, emailed: sent.status === 'sent' });
}, (req) => `/customers/${req.params.id}`));

router.post('/customers/:id/portal-revoke', requireAuth, requirePermission('customers.edit'), action(async (req, res) => {
  const c = await customers.get(req.params.id);
  if (!c || !c.member_id) throw new Error('No portal login to remove.');
  await db.prepare('UPDATE members SET active = 0 WHERE id = ? AND role = ?').run(c.member_id, 'customer');
  await db.prepare('UPDATE customers SET member_id = NULL WHERE id = ?').run(c.id);
  await audit.log(req, 'customer.portal_revoke', 'customer', c.id);
  flash(res, `/customers/${c.id}`, 'notice', 'Portal access removed.');
}, (req) => `/customers/${req.params.id}`));

// ---------------------------------------------------------------- customer side
router.use('/my', requireAuth, requirePermission('portal.customer'), async (req, res, next) => {
  const c = await db.prepare('SELECT * FROM customers WHERE member_id = ? AND active = 1').get(req.member.id);
  if (!c) return res.status(403).render('403', { title: 'Not Authorized', message: 'Your login is not linked to a customer account. Please call us.' });
  req.customer = c;
  next();
});

router.get('/my', async (req, res) => {
  const c = req.customer;
  const [properties, equipment, jobs, invoices, estimates, agreements, requests] = await Promise.all([
    customers.properties(c.id),
    customers.equipmentForCustomer(c.id),
    db.prepare("SELECT j.id, j.job_number, j.title, j.status, j.scheduled_start, j.completed_at, j.work_performed FROM jobs j WHERE j.customer_id = ? AND j.status <> 'cancelled' ORDER BY COALESCE(j.scheduled_start, j.created_at) DESC LIMIT 50").all(c.id),
    db.prepare("SELECT id, invoice_number, issue_date, due_date, total_cents, amount_paid_cents, credited_cents, status, public_token FROM invoices WHERE customer_id = ? AND status NOT IN ('draft','void') ORDER BY id DESC").all(c.id),
    db.prepare("SELECT id, estimate_number, title, total_cents, status, expires_on, public_token FROM estimates WHERE customer_id = ? AND status NOT IN ('draft','superseded') ORDER BY id DESC").all(c.id),
    db.prepare("SELECT a.*, (SELECT MIN(due_date) FROM agreement_visits v WHERE v.agreement_id = a.id AND v.status IN ('due','scheduled')) AS \"nextVisit\" FROM maintenance_agreements a WHERE a.customer_id = ? AND a.status = 'active'").all(c.id),
    serviceRequests.list({ customerId: c.id, limit: 20 }),
  ]);
  res.render('my-portal', { title: 'My Account', c, properties, equipment, jobs, invoices, estimates, agreements, requests, company: await settings.all(), kinds: serviceRequests.KINDS.filter((k) => k !== 'complaint').concat(['complaint']) });
});

router.post('/my/request', action(async (req, res) => {
  const c = req.customer;
  const prop = req.body.property_id ? await customers.getProperty(req.body.property_id) : null;
  if (prop && prop.customer_id !== c.id) throw new Error('Choose one of your addresses.');
  const { request } = await serviceRequests.intake({ customer_id: c.id, property_id: prop ? prop.id : null, address: req.body.address, city: req.body.city, state: req.body.state, zip: req.body.zip, kind: req.body.kind, description: req.body.description, preferred_date: req.body.preferred_date, preferred_time: req.body.preferred_time, source: 'portal' });
  await audit.log(req, 'service_request.portal', 'service_request', request.id);
  flash(res, '/my', 'notice', `Request ${request.request_number} received. We'll contact you to schedule.`);
}, '/my'));

module.exports = router;
