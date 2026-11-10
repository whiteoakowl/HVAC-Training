// Accounting: chart of accounts, journal, manual entries, and financial
// statements computed from the ledger.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const accounting = require('../utils/accounting');
const invoices = require('../utils/invoices');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action, asArray } = require('../utils/http');

router.use(requireAuth, requirePermission('accounting.view'));

function range(req) {
  const today = fmt.today();
  const from = fmt.dateOnly(req.query.from) || today.slice(0, 8) + '01';
  const to = fmt.dateOnly(req.query.to) || today;
  return { from, to };
}

function sendCsv(res, name, rows, columns) {
  res.type('text/csv').attachment(name);
  res.send(fmt.csv(rows, columns));
}

router.get('/', async (req, res) => {
  const rows = await accounting.balances();
  res.render('accounting-home', { title: 'Accounting', rows, types: accounting.TYPES });
});

router.post('/accounts', requirePermission('accounting.manage'), action(async (req, res) => {
  const code = fmt.clean(req.body.code, 10);
  const name = fmt.clean(req.body.name, 100);
  if (!code || !/^\d{3,6}$/.test(code)) throw new Error('Account code must be 3-6 digits.');
  if (!name) throw new Error('Account name is required.');
  if (!accounting.TYPES.includes(req.body.type)) throw new Error('Choose an account type.');
  if (await db.prepare('SELECT 1 AS x FROM accounts WHERE code = ?').get(code)) throw new Error(`Account ${code} already exists.`);
  const info = await db.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)').run(code, name, req.body.type);
  await audit.log(req, 'account.create', 'account', info.lastInsertRowid, { code, name, type: req.body.type });
  flash(res, '/accounting', 'notice', `Account ${code} ${name} added.`);
}, '/accounting'));

router.post('/accounts/:id/active', requirePermission('accounting.manage'), action(async (req, res) => {
  const a = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!a) throw new Error('Account not found.');
  if (a.is_system && req.body.active === '0') throw new Error('System accounts are used by automatic postings and cannot be deactivated.');
  await db.prepare('UPDATE accounts SET active = ? WHERE id = ?').run(req.body.active === '0' ? 0 : 1, a.id);
  await audit.log(req, 'account.active', 'account', a.id, { active: req.body.active });
  flash(res, '/accounting', 'notice', 'Account updated.');
}, '/accounting'));

router.get('/journal', async (req, res) => {
  const { from, to } = range(req);
  const accountId = parseInt(req.query.account_id, 10) || null;
  const entries = await accounting.listEntries({ from, to, accountId, limit: 1000 });
  res.render('accounting-journal', { title: 'General Journal', entries, from, to, accountId, accounts: await accounting.listAccounts() });
});

router.get('/journal/new', requirePermission('accounting.manage'), async (req, res) => {
  res.render('accounting-entry-form', { title: 'New Journal Entry', accounts: await accounting.listAccounts({ activeOnly: true }), today: fmt.today() });
});

router.post('/journal/new', requirePermission('accounting.manage'), action(async (req, res) => {
  const memo = fmt.clean(req.body.memo, 300);
  if (!memo) throw new Error('A memo is required.');
  const accts = asArray(req.body.account_id);
  const debits = asArray(req.body.debit);
  const credits = asArray(req.body.credit);
  const descs = asArray(req.body.line_description);
  const lines = accts.map((a, i) => ({ accountId: parseInt(a, 10), debit: fmt.toCents(debits[i]) || 0, credit: fmt.toCents(credits[i]) || 0, description: fmt.clean(descs[i], 200) })).filter((l) => l.accountId && (l.debit || l.credit));
  for (const l of lines) if (l.debit && l.credit) throw new Error('A line can have a debit or a credit, not both.');
  const valid = new Set((await accounting.listAccounts({ activeOnly: true })).map((a) => a.id));
  for (const l of lines) if (!valid.has(l.accountId)) throw new Error('Choose active accounts only.');
  const id = await db.withTransaction((tx) => accounting.post(tx, { date: req.body.entry_date, memo, sourceType: 'manual', lines, memberId: req.member.id }));
  await audit.log(req, 'journal.create', 'journal_entry', id);
  flash(res, `/accounting/journal/${id}`, 'notice', 'Journal entry posted.');
}, '/accounting/journal/new'));

router.get('/journal/:id', async (req, res) => {
  const entry = await accounting.getEntry(req.params.id);
  if (!entry) return res.status(404).render('404', { title: 'Not Found' });
  res.render('accounting-entry', { title: `Journal entry #${entry.id}`, entry });
});

router.post('/journal/:id/reverse', requirePermission('accounting.manage'), action(async (req, res) => {
  const entry = await accounting.getEntry(req.params.id);
  if (!entry) throw new Error('Entry not found.');
  if (entry.source_type !== 'manual') throw new Error('Automatic entries are reversed from their source (for example by voiding the invoice).');
  const id = await db.withTransaction((tx) => accounting.reverse(tx, entry.id, { memberId: req.member.id, memo: fmt.clean(req.body.memo, 300) || undefined }));
  await audit.log(req, 'journal.reverse', 'journal_entry', entry.id, { reversal: id });
  flash(res, `/accounting/journal/${id}`, 'notice', 'Reversing entry posted.');
}, (req) => `/accounting/journal/${req.params.id}`));

// ---------------------------------------------------------------- reports
router.get('/reports/profit-loss', async (req, res) => {
  const { from, to } = range(req);
  const pl = await accounting.profitAndLoss(from, to);
  if (req.query.format === 'csv') return sendCsv(res, `profit-loss-${from}-${to}.csv`, pl.rows.filter((r) => r.balance), [{ label: 'Code', value: 'code' }, { label: 'Account', value: 'name' }, { label: 'Type', value: 'type' }, { label: 'Amount', value: (r) => fmt.centsInput(r.balance) }]);
  res.render('report-pl', { title: 'Profit & Loss', pl, from, to });
});

router.get('/reports/balance-sheet', async (req, res) => {
  const asOf = fmt.dateOnly(req.query.as_of) || fmt.today();
  const bs = await accounting.balanceSheet(asOf);
  if (req.query.format === 'csv') return sendCsv(res, `balance-sheet-${asOf}.csv`, bs.rows.filter((r) => r.balance), [{ label: 'Code', value: 'code' }, { label: 'Account', value: 'name' }, { label: 'Type', value: 'type' }, { label: 'Balance', value: (r) => fmt.centsInput(r.balance) }]);
  res.render('report-bs', { title: 'Balance Sheet', bs, asOf });
});

router.get('/reports/trial-balance', async (req, res) => {
  const asOf = fmt.dateOnly(req.query.as_of) || fmt.today();
  const tb = await accounting.trialBalance(asOf);
  if (req.query.format === 'csv') return sendCsv(res, `trial-balance-${asOf}.csv`, tb.rows, [{ label: 'Code', value: 'code' }, { label: 'Account', value: 'name' }, { label: 'Debit', value: (r) => fmt.centsInput(r.debit) }, { label: 'Credit', value: (r) => fmt.centsInput(r.credit) }]);
  res.render('report-tb', { title: 'Trial Balance', tb, asOf });
});

router.get('/reports/cash-flow', async (req, res) => {
  const { from, to } = range(req);
  const cf = await accounting.cashFlow(from, to);
  if (req.query.format === 'csv') return sendCsv(res, `cash-flow-${from}-${to}.csv`, cf.rows, [{ label: 'Code', value: 'code' }, { label: 'Counter-account', value: 'name' }, { label: 'Net cash', value: (r) => fmt.centsInput(r.amount) }]);
  res.render('report-cf', { title: 'Cash Flow', cf, from, to });
});

router.get('/reports/ar-aging', async (req, res) => {
  const asOf = fmt.dateOnly(req.query.as_of) || fmt.today();
  const ag = await invoices.aging(asOf);
  if (req.query.format === 'csv') return sendCsv(res, `ar-aging-${asOf}.csv`, ag.rows, [{ label: 'Invoice', value: 'invoice_number' }, { label: 'Customer', value: 'customerName' }, { label: 'Due', value: 'due_date' }, { label: 'Days overdue', value: 'daysOverdue' }, { label: 'Bucket', value: 'bucket' }, { label: 'Balance', value: (r) => fmt.centsInput(r.balance) }]);
  res.render('report-aging', { title: 'A/R Aging', ag, asOf });
});

router.get('/reports/sales-tax', async (req, res) => {
  const { from, to } = range(req);
  const rows = await db
    .prepare("SELECT invoice_number, issue_date, tax_rate_bp, taxable_cents, tax_cents, subtotal_cents, discount_cents, total_cents FROM invoices WHERE status IN ('issued','partial','paid') AND issue_date >= ? AND issue_date <= ? ORDER BY issue_date")
    .all(from, to);
  const totals = rows.reduce((t, r) => ({ sales: t.sales + r.subtotal_cents - r.discount_cents, taxable: t.taxable + r.taxable_cents, tax: t.tax + r.tax_cents }), { sales: 0, taxable: 0, tax: 0 });
  const ledger = (await accounting.balances({ from, to })).find((r) => r.code === '2100');
  if (req.query.format === 'csv') return sendCsv(res, `sales-tax-${from}-${to}.csv`, rows, [{ label: 'Invoice', value: 'invoice_number' }, { label: 'Date', value: 'issue_date' }, { label: 'Rate %', value: (r) => (r.tax_rate_bp / 100).toFixed(2) }, { label: 'Taxable', value: (r) => fmt.centsInput(r.taxable_cents) }, { label: 'Tax', value: (r) => fmt.centsInput(r.tax_cents) }]);
  res.render('report-tax', { title: 'Sales Tax', rows, totals, ledgerCredits: ledger ? ledger.credits - ledger.debits : 0, from, to });
});

module.exports = router;
