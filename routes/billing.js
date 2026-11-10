// Invoices and payments.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const invoices = require('../utils/invoices');
const customers = require('../utils/customers');
const settings = require('../utils/settings');
const automation = require('../utils/automation');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

router.use(requireAuth, requirePermission('invoices.view', 'invoices.manage'));

router.get('/', async (req, res) => {
  const status = ['draft', 'issued', 'partial', 'paid', 'void', 'open'].includes(req.query.status) ? req.query.status : null;
  const overdue = req.query.overdue === '1';
  const rows = await invoices.list({ status, overdue, q: req.query.q || null });
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment('invoices.csv');
    return res.send(fmt.csv(rows, [
      { label: 'Invoice', value: 'invoice_number' }, { label: 'Customer', value: 'customerName' }, { label: 'Job', value: 'job_number' }, { label: 'Status', value: 'status' },
      { label: 'Issued', value: 'issue_date' }, { label: 'Due', value: 'due_date' }, { label: 'Total', value: (r) => fmt.centsInput(r.total_cents) },
      { label: 'Paid', value: (r) => fmt.centsInput(r.amount_paid_cents) }, { label: 'Balance', value: (r) => fmt.centsInput(r.total_cents - r.amount_paid_cents) },
    ]));
  }
  res.render('invoices-list', { title: 'Invoices', rows, status, overdue, q: req.query.q || '', today: fmt.today() });
});

router.post('/new', requirePermission('invoices.manage'), action(async (req, res) => {
  const c = await customers.get(req.body.customer_id);
  if (!c) throw new Error('Customer not found.');
  const id = await invoices.createBlank(c.id, req.member.id);
  await audit.log(req, 'invoice.create', 'invoice', id);
  flash(res, `/invoices/${id}`, 'notice', 'Draft invoice created. Add lines, then issue it.');
}, (req) => `/customers/${encodeURIComponent(req.body.customer_id || '')}`));

async function load(req, res, next) {
  const inv = await invoices.details(req.params.id);
  if (!inv) return res.status(404).render('404', { title: 'Not Found' });
  req.inv = inv;
  next();
}
const back = (req) => `/invoices/${req.params.id}`;

router.get('/:id', load, async (req, res) => {
  const s = await settings.all();
  res.render('invoice', { title: req.inv.invoice_number, inv: req.inv, company: s, kinds: invoices.KINDS, methods: invoices.METHODS, today: fmt.today(), print: req.query.print === '1' });
});

router.post('/:id/edit', requirePermission('invoices.manage'), load, action(async (req, res) => {
  const rate = fmt.toNumber(req.body.tax_rate);
  await invoices.editDraft(req.inv.id, { discountCents: fmt.toCents(req.body.discount) || 0, taxRateBp: rate === null ? 0 : Math.round(rate * 100), terms: req.body.terms, notes: req.body.notes, dueDate: req.body.due_date });
  await audit.log(req, 'invoice.update', 'invoice', req.inv.id);
  flash(res, back(req), 'notice', 'Invoice updated.');
}, back));

router.post('/:id/lines', requirePermission('invoices.manage'), load, action(async (req, res) => {
  await invoices.addDraftLine(req.inv.id, { kind: req.body.kind, description: req.body.description, quantity: fmt.toNumber(req.body.quantity), unitPriceCents: fmt.toCents(req.body.unit_price), taxable: req.body.taxable === '1' });
  await audit.log(req, 'invoice.line_add', 'invoice', req.inv.id);
  flash(res, back(req), 'notice', 'Line added.');
}, back));

router.post('/:id/lines/:lineId/delete', requirePermission('invoices.manage'), load, action(async (req, res) => {
  await invoices.removeDraftLine(req.inv.id, req.params.lineId);
  await audit.log(req, 'invoice.line_remove', 'invoice', req.inv.id);
  flash(res, back(req), 'notice', 'Line removed.');
}, back));

router.post('/:id/issue', requirePermission('invoices.manage'), load, action(async (req, res) => {
  await invoices.issue(req.inv.id, req.member.id, req.body.issue_date);
  await audit.log(req, 'invoice.issue', 'invoice', req.inv.id, { total: req.inv.total_cents });
  flash(res, back(req), 'notice', 'Invoice issued and posted to accounts receivable.');
}, back));

router.post('/:id/payments', requirePermission('payments.record'), load, action(async (req, res) => {
  const amount = fmt.toCents(req.body.amount);
  const r = await invoices.recordPayment(req.inv.id, { amountCents: amount, method: req.body.method, reference: req.body.reference, receivedOn: req.body.received_on }, req.member.id);
  await audit.log(req, 'payment.record', 'invoice', req.inv.id, { amount, method: req.body.method, paymentId: r.paymentId });
  await automation.notifyPermission(['accounting.view'], 'payment_received', { title: `Payment ${fmt.money(amount)} on ${req.inv.invoice_number}`, body: `${req.inv.customerName} · ${req.body.method}`, linkUrl: back(req) }, req.member.id);
  flash(res, back(req), 'notice', r.status === 'paid' ? 'Payment recorded. Invoice is paid in full.' : `Payment recorded. Balance due ${fmt.money(r.balance)}.`);
}, back));

router.post('/:id/void', requirePermission('invoices.manage'), load, action(async (req, res) => {
  await invoices.voidInvoice(req.inv.id, req.body.reason, req.member.id);
  await audit.log(req, 'invoice.void', 'invoice', req.inv.id, { reason: req.body.reason });
  flash(res, back(req), 'notice', 'Invoice voided and its accounting entry reversed.');
}, back));

module.exports = router;
