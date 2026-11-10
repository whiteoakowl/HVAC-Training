// Expenses (paid directly) and recurring expenses.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const expenses = require('../utils/expenses');
const purchasing = require('../utils/purchasing');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.use(requireAuth, requirePermission('expenses.manage'));

router.get('/', async (req, res) => {
  const today = fmt.today();
  const from = fmt.dateOnly(req.query.from) || today.slice(0, 8) + '01';
  const to = fmt.dateOnly(req.query.to) || today;
  const accountId = parseInt(req.query.account_id, 10) || null;
  const rows = await expenses.list({ from, to, accountId });
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`expenses-${from}-${to}.csv`);
    return res.send(fmt.csv(rows, [
      { label: 'Date', value: 'expense_date' }, { label: 'Payee', value: 'payee' }, { label: 'Category', value: (r) => `${r.code} ${r.accountName}` }, { label: 'Amount', value: (r) => fmt.centsInput(r.amount_cents) },
      { label: 'Paid from', value: (r) => expenses.PAID_FROM[r.paid_from_code] }, { label: 'Job', value: 'job_number' }, { label: 'Truck', value: 'truckName' }, { label: 'Description', value: 'description' }, { label: 'Status', value: 'status' },
    ]));
  }
  const byCategory = {};
  for (const r of rows.filter((x) => x.status === 'posted')) byCategory[`${r.code} ${r.accountName}`] = (byCategory[`${r.code} ${r.accountName}`] || 0) + r.amount_cents;
  res.render('expenses', {
    title: 'Expenses', rows, from, to, accountId, byCategory, accounts: await expenses.expenseAccounts(), paidFrom: expenses.PAID_FROM, frequencies: expenses.FREQUENCIES,
    recurring: await expenses.listRecurring(), due: await expenses.dueRecurring(), vendors: await purchasing.listVendors({ activeOnly: true }), today,
    trucks: await db.prepare('SELECT id, name FROM trucks WHERE active = 1 ORDER BY name').all(),
    staff: await db.prepare("SELECT id, name FROM members WHERE active = 1 AND role NOT IN ('customer','student') ORDER BY name").all(),
  });
});

router.post('/', upload.single('receipt'), action(async (req, res) => {
  const job = req.body.job_number ? await db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(req.body.job_number.trim().toUpperCase()) : null;
  if (req.body.job_number && !job) throw new Error(`Job ${req.body.job_number} not found.`);
  const id = await expenses.record({
    date: req.body.expense_date, payee: req.body.payee, vendorId: parseInt(req.body.vendor_id, 10) || null, accountId: parseInt(req.body.account_id, 10), paidFrom: req.body.paid_from,
    amountCents: fmt.toCents(req.body.amount), description: req.body.description, jobId: job ? job.id : null, truckId: parseInt(req.body.truck_id, 10) || null,
    memberId: parseInt(req.body.member_id, 10) || null, receipt: req.file,
  }, req.member.id);
  if (job && req.body.job_cost === '1') {
    const acct = await db.prepare('SELECT code FROM accounts WHERE id = ?').get(req.body.account_id);
    const category = acct && acct.code === '5200' ? 'subcontractor' : acct && acct.code === '5300' ? 'permit' : 'other';
    await db.prepare('INSERT INTO job_costs (job_id, category, description, amount_cents, member_id) VALUES (?, ?, ?, ?, ?)').run(job.id, category, `Expense #${id}: ${req.body.payee}`, fmt.toCents(req.body.amount), req.member.id);
  }
  await audit.log(req, 'expense.create', 'expense', id);
  flash(res, '/expenses', 'notice', 'Expense recorded and posted to the ledger.');
}, '/expenses'));

router.get('/:id/receipt', async (req, res) => {
  const e = await db.prepare('SELECT receipt, receipt_name, receipt_mime FROM expenses WHERE id = ?').get(req.params.id);
  if (!e || !e.receipt) return res.status(404).render('404', { title: 'Not Found' });
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(e.receipt_mime || '');
  res.set('X-Content-Type-Options', 'nosniff').type(inline ? e.receipt_mime : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(e.receipt_name || 'receipt').replace(/[^\w.\- ]/g, '_')}"`);
  res.send(Buffer.from(e.receipt));
});

router.post('/:id/void', action(async (req, res) => {
  await expenses.voidExpense(req.params.id, req.body.reason, req.member.id);
  await audit.log(req, 'expense.void', 'expense', req.params.id, { reason: req.body.reason });
  flash(res, '/expenses', 'notice', 'Expense voided and reversed.');
}, '/expenses'));

router.post('/recurring', action(async (req, res) => {
  await expenses.saveRecurring({ payee: req.body.payee, accountId: parseInt(req.body.account_id, 10), paidFrom: req.body.paid_from, amountCents: fmt.toCents(req.body.amount), frequency: req.body.frequency, nextDue: req.body.next_due, description: req.body.description });
  await audit.log(req, 'recurring_expense.create', 'recurring_expense', null, { payee: req.body.payee });
  flash(res, '/expenses#recurring', 'notice', 'Recurring expense saved. You will be reminded when it is due.');
}, '/expenses'));

router.post('/recurring/:id/post', action(async (req, res) => {
  const id = await expenses.postRecurring(req.params.id, { amountCents: fmt.toCents(req.body.amount), date: req.body.date }, req.member.id);
  await audit.log(req, 'recurring_expense.post', 'expense', id, { recurringId: req.params.id });
  flash(res, '/expenses#recurring', 'notice', 'Posted. Next due date moved forward.');
}, '/expenses'));

router.post('/recurring/:id/active', action(async (req, res) => {
  await expenses.setRecurringActive(req.params.id, req.body.active === '1');
  flash(res, '/expenses#recurring', 'notice', 'Updated.');
}, '/expenses'));

module.exports = router;
