// Customer Service portal home: today's queue for office staff. No
// payroll or company-financial data is loaded here.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const serviceRequests = require('../utils/serviceRequests');
const customers = require('../utils/customers');
const jobs = require('../utils/jobs');
const invoices = require('../utils/invoices');
const fmt = require('../utils/format');

router.use(requireAuth, requirePermission('portal.service'));

router.get('/', async (req, res) => {
  const today = fmt.today();
  const q = (req.query.q || '').trim();
  const [requests, todayJobs, followUps, unscheduled, results, overdue] = await Promise.all([
    req.can('requests.view', 'requests.manage') ? serviceRequests.list({ open: true, limit: 50 }) : [],
    jobs.list({ from: today + ' 00:00:00', to: today + ' 23:59:59', limit: 200 }),
    req.can('customers.view') ? customers.followUpsDue(today) : [],
    req.can('jobs.view_all') ? (await jobs.list({ open: true, limit: 300 })).filter((j) => !j.scheduled_start && j.status !== 'cancelled') : [],
    q && req.can('customers.view') ? customers.search(q, { limit: 25 }) : [],
    req.can('invoices.view', 'invoices.manage') ? invoices.list({ overdue: true, limit: 50 }) : [],
  ]);
  res.render('service-desk', { title: 'Service Desk', requests, todayJobs, followUps, unscheduled, results, overdue, q, today });
});

module.exports = router;
