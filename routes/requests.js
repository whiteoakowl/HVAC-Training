// Service requests (office intake; website form requests land here too).
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const serviceRequests = require('../utils/serviceRequests');
const customers = require('../utils/customers');
const audit = require('../utils/audit');
const { flash, action } = require('../utils/http');

router.use(requireAuth, requirePermission('requests.view', 'requests.manage'));

router.get('/', async (req, res) => {
  const status = serviceRequests.STATUSES.includes(req.query.status) ? req.query.status : null;
  const open = !status && req.query.all !== '1';
  res.render('requests-list', { title: 'Service Requests', rows: await serviceRequests.list({ status, open }), status, open, statuses: serviceRequests.STATUSES });
});

router.get('/new', requirePermission('requests.manage'), async (req, res) => {
  const customer = req.query.customer_id ? await customers.get(req.query.customer_id) : null;
  res.render('requests-form', { title: 'New Service Request', customer, properties: customer ? await customers.properties(customer.id) : [], kinds: serviceRequests.KINDS });
});

router.post('/new', requirePermission('requests.manage'), action(async (req, res) => {
  const data = { ...req.body, source: req.body.source || 'phone' };
  if (data.property_id === 'new' || !data.property_id) delete data.property_id;
  const { request, customerCreated } = await serviceRequests.intake(data, { memberId: req.member.id });
  await audit.log(req, 'service_request.create', 'service_request', request.id, { customerCreated });
  flash(res, `/requests/${request.id}`, 'notice', `${request.request_number} created${customerCreated ? ' with a new customer record' : ' for existing customer ' + request.customer_number}.`);
}, (req) => (req.body.customer_id ? `/requests/new?customer_id=${encodeURIComponent(req.body.customer_id)}` : '/requests/new')));

async function load(req, res, next) {
  const sr = await serviceRequests.get(req.params.id);
  if (!sr) return res.status(404).render('404', { title: 'Not Found' });
  req.sr = sr;
  next();
}

router.get('/:id', load, (req, res) => {
  res.render('requests-detail', { title: req.sr.request_number, sr: req.sr, statuses: serviceRequests.STATUSES });
});

router.post('/:id/status', requirePermission('requests.manage'), load, action(async (req, res) => {
  await serviceRequests.setStatus(req.sr.id, req.body.status);
  await audit.log(req, 'service_request.status', 'service_request', req.sr.id, { status: req.body.status });
  flash(res, `/requests/${req.sr.id}`, 'notice', 'Status updated.');
}, (req) => `/requests/${req.params.id}`));

router.post('/:id/convert', requirePermission('jobs.manage'), load, action(async (req, res) => {
  const jobId = await serviceRequests.convertToJob(req.sr.id, req.member.id, { title: req.body.title });
  await audit.log(req, 'service_request.convert', 'service_request', req.sr.id, { jobId });
  flash(res, `/jobs/${jobId}`, 'notice', 'Job created from the request. Assign a technician and schedule it below.');
}, (req) => `/requests/${req.params.id}`));

module.exports = router;
