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
const banking = require('../utils/banking');
const settings = require('../utils/settings');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

// QuickBooks-style overview.
router.get('/', async (req, res) => {
  const today = fmt.today();
  const months = [];
  for (let k = 5; k >= 0; k--) {
    const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - k, 1));
    const start = d.toISOString().slice(0, 10);
    const end = fmt.addDays(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10), -1);
    const pl = await accounting.profitAndLoss(start, end < today ? end : today);
    months.push({ label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), income: pl.income, expense: pl.cogs + pl.expense, net: pl.netIncome });
  }
  const scalar = async (sql, ...p) => Number(Object.values((await db.prepare(sql).get(...p)) || { v: 0 })[0] || 0);
  res.render('accounting-overview', {
    title: 'Accounting', months, today,
    month: await accounting.profitAndLoss(today.slice(0, 8) + '01', today), year: await accounting.profitAndLoss(today.slice(0, 5) + '01-01', today),
    banks: await banking.bankAccounts(),
    ar: { open: await scalar("SELECT COALESCE(SUM(total_cents - amount_paid_cents - credited_cents), 0) FROM invoices WHERE status IN ('issued','partial')"), overdue: await scalar("SELECT COALESCE(SUM(total_cents - amount_paid_cents - credited_cents), 0) FROM invoices WHERE status IN ('issued','partial') AND due_date < ?", today), drafts: await scalar("SELECT COUNT(*) FROM invoices WHERE status = 'draft'") },
    ap: { open: await scalar("SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) FROM vendor_bills WHERE status IN ('open','partial')"), overdue: await scalar("SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) FROM vendor_bills WHERE status IN ('open','partial') AND due_date < ?", today) },
    closed: await accounting.closedThrough(), recent: await accounting.listEntries({ limit: 8 }),
  });
});

// Chart of accounts.
router.get('/accounts', async (req, res) => {
  const rows = await accounting.balances();
  res.render('accounting-home', { title: 'Chart of Accounts', rows, types: accounting.TYPES });
});

router.get('/accounts/:id/register', async (req, res) => {
  const { from, to } = { from: fmt.dateOnly(req.query.from) || fmt.today().slice(0, 5) + '01-01', to: fmt.dateOnly(req.query.to) || fmt.today() };
  const reg = await banking.register(req.params.id, { from, to }).catch(() => null);
  if (!reg) return res.status(404).render('404', { title: 'Not Found' });
  if (req.query.format === 'csv') {
    return sendCsv(res, `register-${reg.account.code}-${from}-${to}.csv`, reg.rows, [
      { label: 'Date', value: (r) => fmt.d(r.entry_date) }, { label: 'Memo', value: 'memo' }, { label: 'Account', value: 'split' },
      { label: 'Amount', value: (r) => fmt.centsInput(r.change) }, { label: 'Balance', value: (r) => fmt.centsInput(r.balance) }, { label: 'Reconciled', value: (r) => (r.reconciliation_id ? 'R' : '') },
    ]);
  }
  res.render('accounting-register', { title: `${reg.account.code} ${reg.account.name}`, reg, from, to });
});

// ---------------------------------------------------------------- banking
router.get('/banking', async (req, res) => {
  res.render('banking', {
    title: 'Banking', banks: await banking.bankAccounts(), rules: await banking.rules(), subtypes: banking.SUBTYPES,
    categories: await accounting.listAccounts({ activeOnly: true }), today: fmt.today(),
  });
});

router.post('/banking/accounts', requirePermission('accounting.manage'), action(async (req, res) => {
  const id = await banking.addBankAccount({ name: req.body.name, subtype: req.body.subtype, last4: req.body.last4, openingBalanceCents: fmt.toCents(req.body.opening_balance) || 0, openingDate: req.body.opening_date }, req.member.id);
  await audit.log(req, 'bank.account_create', 'account', id);
  flash(res, `/accounting/banking/${id}`, 'notice', 'Account added. Import a statement (CSV) from your bank to start.');
}, '/accounting/banking'));

router.post('/banking/transfer', requirePermission('accounting.manage'), action(async (req, res) => {
  const id = await banking.transfer({ fromId: req.body.from_id, toId: req.body.to_id, amountCents: fmt.toCents(req.body.amount), date: req.body.date, memo: req.body.memo }, req.member.id);
  await audit.log(req, 'bank.transfer', 'journal_entry', id);
  flash(res, '/accounting/banking', 'notice', 'Transfer recorded.');
}, '/accounting/banking'));

router.post('/banking/rules', requirePermission('accounting.manage'), action(async (req, res) => {
  await banking.addRule({ matchText: req.body.match_text, direction: req.body.direction, accountId: parseInt(req.body.account_id, 10), payee: req.body.payee }, req.member.id);
  flash(res, req.body.back && /^\/accounting\/banking/.test(req.body.back) ? req.body.back : '/accounting/banking#rules', 'notice', 'Rule saved.');
}, '/accounting/banking'));

router.post('/banking/rules/:id/delete', requirePermission('accounting.manage'), action(async (req, res) => {
  await banking.deleteRule(req.params.id);
  flash(res, '/accounting/banking#rules', 'notice', 'Rule deleted.');
}, '/accounting/banking'));

const bankBack = (req) => `/accounting/banking/${req.params.id}`;

router.get('/banking/:id', async (req, res) => {
  const acct = await banking.bankAccount(req.params.id).catch(() => null);
  if (!acct) return res.status(404).render('404', { title: 'Not Found' });
  res.render('banking-account', {
    title: acct.name, acct, review: await banking.forReview(acct.id), handled: await banking.handled(acct.id, 50), history: await banking.reconciliationHistory(acct.id),
    categories: (await accounting.listAccounts({ activeOnly: true })).filter((a) => a.id !== acct.id), today: fmt.today(),
    balance: ((await accounting.balances()).find((b) => b.id === acct.id) || { balance: 0 }).balance,
  });
});

router.post('/banking/:id/import', requirePermission('accounting.manage'), upload.single('file'), action(async (req, res) => {
  if (!req.file) throw new Error('Choose the CSV file you downloaded from your bank.');
  const r = await banking.importCsv(req.params.id, req.file.buffer.toString('utf8'), { fileName: req.file.originalname, flipSign: req.body.flip_sign === '1' }, req.member.id);
  await audit.log(req, 'bank.import', 'account', req.params.id, r);
  flash(res, bankBack(req), 'notice', `${r.added} new transaction(s) ready for review${r.skipped ? `, ${r.skipped} skipped (already imported or blank)` : ''}.`);
}, bankBack));

router.post('/banking/:id/txn/:tid/:op', requirePermission('accounting.manage'), action(async (req, res) => {
  const { op } = req.params;
  if (op === 'match') await banking.match(parseInt(req.params.id, 10), req.params.tid, parseInt(req.body.line_id, 10), req.member.id);
  else if (op === 'add') {
    await banking.add(parseInt(req.params.id, 10), req.params.tid, { categoryId: parseInt(req.body.category_id, 10), payee: req.body.payee, memo: req.body.memo }, req.member.id);
    if (req.body.make_rule === '1' && req.body.rule_text) await banking.addRule({ matchText: req.body.rule_text, direction: 'any', accountId: parseInt(req.body.category_id, 10), payee: req.body.payee }, req.member.id);
  } else if (op === 'exclude') await banking.exclude(parseInt(req.params.id, 10), req.params.tid, req.member.id);
  else if (op === 'undo') await banking.undo(parseInt(req.params.id, 10), req.params.tid, req.member.id);
  else throw new Error('Unknown action.');
  await audit.log(req, 'bank.' + op, 'bank_transaction', req.params.tid);
  flash(res, bankBack(req) + (op === 'undo' ? '#handled' : '#review'), 'notice', { match: 'Matched.', add: 'Added to the books.', exclude: 'Excluded.', undo: 'Moved back to For review.' }[op]);
}, bankBack));

router.post('/banking/:id/reconcile', requirePermission('accounting.manage'), action(async (req, res) => {
  const rid = await banking.startReconciliation(parseInt(req.params.id, 10), { statementDate: req.body.statement_date, statementBalanceCents: fmt.toCents(req.body.statement_balance) }, req.member.id);
  res.redirect(`/accounting/reconcile/${rid}`);
}, bankBack));

router.get('/reconcile/:rid', async (req, res) => {
  const r = await banking.reconciliation(req.params.rid);
  if (!r) return res.status(404).render('404', { title: 'Not Found' });
  res.render('reconcile', { title: `Reconcile ${r.accountName}`, r });
});

router.post('/reconcile/:rid', requirePermission('accounting.manage'), action(async (req, res) => {
  await banking.setCleared(req.params.rid, asArray(req.body.line_ids).map((x) => parseInt(x, 10)).filter(Boolean), req.member.id);
  if (req.body.finish === '1') {
    await banking.finishReconciliation(req.params.rid, req.member.id);
    const r = await banking.reconciliation(req.params.rid);
    await audit.log(req, 'bank.reconciled', 'account', r.account_id, { statementDate: r.statement_date, balance: r.statement_balance_cents });
    return flash(res, `/accounting/banking/${r.account_id}#reconcile`, 'notice', `Reconciled through ${fmt.d(r.statement_date)}.`);
  }
  flash(res, `/accounting/reconcile/${req.params.rid}`, 'notice', 'Saved. Finish when the difference is $0.00.');
}, (req) => `/accounting/reconcile/${req.params.rid}`));

router.post('/reconcile/:rid/undo', requirePermission('accounting.manage'), action(async (req, res) => {
  const r = await db.prepare('SELECT account_id FROM bank_reconciliations WHERE id = ?').get(req.params.rid);
  await banking.undoReconciliation(req.params.rid);
  await audit.log(req, 'bank.reconcile_undo', 'account', r && r.account_id, { reconciliation: req.params.rid });
  flash(res, `/accounting/banking/${r.account_id}#reconcile`, 'notice', 'Reconciliation undone.');
}, '/accounting/banking'));

// ---------------------------------------------------------------- close the books
router.post('/close', requirePermission('accounting.manage'), action(async (req, res) => {
  const date = req.body.clear === '1' ? '' : fmt.dateOnly(req.body.closed_through);
  if (date === null) throw new Error('Choose the closing date.');
  if (date && date >= fmt.today()) throw new Error('You can only close periods that have ended.');
  await settings.set('books_closed_through', date || '');
  await audit.log(req, date ? 'books.closed' : 'books.reopened', null, null, { through: date });
  flash(res, '/accounting', 'notice', date ? `Books closed through ${fmt.d(date)}. Nothing can be posted on or before that date.` : 'Books reopened.');
}, '/accounting'));

router.post('/accounts', requirePermission('accounting.manage'), action(async (req, res) => {
  const code = fmt.clean(req.body.code, 10);
  const name = fmt.clean(req.body.name, 100);
  if (!code || !/^\d{3,6}$/.test(code)) throw new Error('Account code must be 3-6 digits.');
  if (!name) throw new Error('Account name is required.');
  if (!accounting.TYPES.includes(req.body.type)) throw new Error('Choose an account type.');
  if (await db.prepare('SELECT 1 AS x FROM accounts WHERE code = ?').get(code)) throw new Error(`Account ${code} already exists.`);
  const info = await db.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)').run(code, name, req.body.type);
  await audit.log(req, 'account.create', 'account', info.lastInsertRowid, { code, name, type: req.body.type });
  flash(res, '/accounting/accounts', 'notice', `Account ${code} ${name} added.`);
}, '/accounting/accounts'));

router.post('/accounts/:id/active', requirePermission('accounting.manage'), action(async (req, res) => {
  const a = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!a) throw new Error('Account not found.');
  if (a.is_system && req.body.active === '0') throw new Error('System accounts are used by automatic postings and cannot be deactivated.');
  await db.prepare('UPDATE accounts SET active = ? WHERE id = ?').run(req.body.active === '0' ? 0 : 1, a.id);
  await audit.log(req, 'account.active', 'account', a.id, { active: req.body.active });
  flash(res, '/accounting/accounts', 'notice', 'Account updated.');
}, '/accounting/accounts'));

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
  if (req.query.format === 'csv') return sendCsv(res, `ar-aging-${asOf}.csv`, ag.rows, [{ label: 'Invoice', value: 'invoice_number' }, { label: 'Customer', value: 'customerName' }, { label: 'Due', value: (r) => fmt.d(r.due_date) }, { label: 'Days overdue', value: 'daysOverdue' }, { label: 'Bucket', value: 'bucket' }, { label: 'Balance', value: (r) => fmt.centsInput(r.balance) }]);
  res.render('report-aging', { title: 'A/R Aging', ag, asOf });
});

router.get('/reports/general-ledger', async (req, res) => {
  const { from, to } = range(req);
  const gl = await accounting.generalLedger(from, to);
  if (req.query.format === 'csv') {
    const rows = gl.flatMap((g) => g.rows.map((r) => ({ ...r, acct: `${g.account.code} ${g.account.name}` })));
    return sendCsv(res, `general-ledger-${from}-${to}.csv`, rows, [{ label: 'Account', value: 'acct' }, { label: 'Date', value: (r) => fmt.d(r.entry_date) }, { label: 'Memo', value: 'memo' }, { label: 'Split', value: 'split' }, { label: 'Debit', value: (r) => fmt.centsInput(r.debit_cents) }, { label: 'Credit', value: (r) => fmt.centsInput(r.credit_cents) }, { label: 'Balance', value: (r) => fmt.centsInput(r.balance) }]);
  }
  res.render('report-gl', { title: 'General Ledger', gl, from, to });
});

router.get('/reports/sales-by-customer', async (req, res) => {
  const { from, to } = range(req);
  const rows = await accounting.salesByCustomer(from, to);
  if (req.query.format === 'csv') return sendCsv(res, `sales-by-customer-${from}-${to}.csv`, rows, [{ label: 'Customer', value: 'name' }, { label: 'Invoices', value: 'invoices' }, { label: 'Sales', value: (r) => fmt.centsInput(r.sales) }, { label: 'Credits', value: (r) => fmt.centsInput(r.credits) }, { label: 'Net', value: (r) => fmt.centsInput(r.net) }, { label: 'Still owed', value: (r) => fmt.centsInput(r.open) }]);
  res.render('report-sales-customer', { title: 'Sales by Customer', rows, from, to });
});

router.get('/reports/expenses-by-payee', async (req, res) => {
  const { from, to } = range(req);
  const rows = await accounting.expensesByPayee(from, to);
  if (req.query.format === 'csv') return sendCsv(res, `expenses-by-payee-${from}-${to}.csv`, rows, [{ label: 'Payee', value: 'name' }, { label: 'Total', value: (r) => fmt.centsInput(r.total) }, { label: 'Categories', value: (r) => Object.keys(r.accounts).join('; ') }]);
  res.render('report-expenses-payee', { title: 'Expenses by Vendor / Payee', rows, from, to });
});

router.get('/reports/sales-tax', async (req, res) => {
  const { from, to } = range(req);
  const rows = await db
    .prepare("SELECT invoice_number, issue_date, tax_rate_bp, taxable_cents, tax_cents, subtotal_cents, discount_cents, total_cents FROM invoices WHERE status IN ('issued','partial','paid') AND issue_date >= ? AND issue_date <= ? ORDER BY issue_date")
    .all(from, to);
  const totals = rows.reduce((t, r) => ({ sales: t.sales + r.subtotal_cents - r.discount_cents, taxable: t.taxable + r.taxable_cents, tax: t.tax + r.tax_cents }), { sales: 0, taxable: 0, tax: 0 });
  const ledger = (await accounting.balances({ from, to })).find((r) => r.code === '2100');
  if (req.query.format === 'csv') return sendCsv(res, `sales-tax-${from}-${to}.csv`, rows, [{ label: 'Invoice', value: 'invoice_number' }, { label: 'Date', value: (r) => fmt.d(r.issue_date) }, { label: 'Rate %', value: (r) => (r.tax_rate_bp / 100).toFixed(2) }, { label: 'Taxable', value: (r) => fmt.centsInput(r.taxable_cents) }, { label: 'Tax', value: (r) => fmt.centsInput(r.tax_cents) }]);
  res.render('report-tax', { title: 'Sales Tax', rows, totals, ledgerCredits: ledger ? ledger.credits - ledger.debits : 0, from, to });
});

module.exports = router;
