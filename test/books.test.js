// Built-in QuickBooks-style bookkeeping: bank import, match vs. add,
// rules, duplicate-proof re-import, undo, transfers, registers,
// reconciliation, closing the books, statements and reports.
const test = require('node:test');
const assert = require('node:assert');
const { start, Client, flashOf, idFrom } = require('./helpers');

let ctx;
let db;
let acct;
let fmt;
let today;
const state = {};

test.before(async () => {
  ctx = await start({ demo: true });
  db = ctx.db;
  fmt = require('../utils/format');
  await require('../utils/settings').applyTimezone(true);
  today = fmt.today();
  acct = new Client(ctx.base);
  await acct.login('accounting@hvacdemo.test');
});
test.after(async () => ctx.stop());

async function bal(code) {
  return (await require('../utils/accounting').balances()).find((r) => r.code === code).balance;
}

function upload(url, csv, extra = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'statement.csv');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fetch(ctx.base + url, { method: 'POST', body: fd, headers: { cookie: acct.cookieHeader() }, redirect: 'manual' });
}

test('overview, chart of accounts and banking pages are accounting-only', async () => {
  for (const url of ['/accounting', '/accounting/accounts', '/accounting/banking']) assert.strictEqual((await acct.get(url)).status, 200, url);
  const tech = new Client(ctx.base);
  await tech.login('tech@hvacdemo.test');
  assert.strictEqual((await tech.get('/accounting/banking')).status, 403);
});

test('bank account with opening balance; CSV import; match a recorded payment; add with a rule; exclude', async () => {
  const r = await acct.post('/accounting/banking/accounts', { subtype: 'bank', name: 'Demo Checking', last4: '4321', opening_balance: '10000.00', opening_date: fmt.addDays(today, -40) });
  const bankId = idFrom(r.url, '/accounting/banking');
  assert.ok(bankId);
  const bank = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(bankId);
  assert.strictEqual(bank.subtype, 'bank');
  assert.strictEqual(bank.code, '1001');
  state.bank = bank;

  // A customer payment recorded on an invoice, deposited into this account
  // is recorded via the normal flow into 1000. To demonstrate matching we
  // record a transfer from 1000 to the new account and then match it.
  const main = await db.prepare("SELECT id FROM accounts WHERE code = '1000'").get();
  await acct.post('/accounting/banking/transfer', { from_id: main.id, to_id: bankId, amount: '250.00', date: fmt.addDays(today, -5), memo: 'Move funds' });

  const fuel = await db.prepare("SELECT id FROM accounts WHERE code = '6100'").get();
  await acct.post('/accounting/banking/rules', { match_text: 'SHELL', direction: 'money_out', account_id: fuel.id, payee: 'Shell' });
  const csv = [
    'Posting Date,Description,Amount',
    `${fmt.d(fmt.addDays(today, -4))},ONLINE TRANSFER FROM CHK,250.00`,
    `${fmt.d(fmt.addDays(today, -3))},SHELL OIL 5741 SPRINGFIELD,-64.20`,
    `${fmt.d(fmt.addDays(today, -3))},SHELL OIL 5741 SPRINGFIELD,-64.20`,
    `${fmt.d(fmt.addDays(today, -2))},"OFFICE DEPOT #2201, SUPPLIES",-38.15`,
    `${fmt.d(fmt.addDays(today, -1))},MONTHLY SERVICE FEE,-15.00`,
  ].join('\n');
  const up = await upload(`/accounting/banking/${bankId}/import`, csv);
  assert.match(decodeURIComponent(up.headers.get('location')), /5 new transaction/);
  // Importing the same file again adds nothing.
  const again = await upload(`/accounting/banking/${bankId}/import`, csv);
  assert.match(decodeURIComponent(again.headers.get('location')), /0 new transaction.*5 skipped/);
  const banking = require('../utils/banking');
  const review = await banking.forReview(bankId);
  assert.strictEqual(review.length, 5);
  const transferIn = review.find((t) => t.amount_cents === 25000);
  assert.strictEqual(transferIn.matches.length, 1, 'suggests the recorded transfer');
  const shell = review.filter((t) => /SHELL/.test(t.description));
  assert.strictEqual(shell.length, 2, 'two identical real purchases kept');
  assert.strictEqual(shell[0].rule.account_id, fuel.id, 'rule suggests Fuel');

  const bank0 = await bal('1001');
  await acct.post(`/accounting/banking/${bankId}/txn/${transferIn.id}/match`, { line_id: transferIn.matches[0].id });
  assert.strictEqual(await bal('1001'), bank0, 'matching posts nothing new');
  const fuel0 = await bal('6100');
  for (const t of shell) await acct.post(`/accounting/banking/${bankId}/txn/${t.id}/add`, { category_id: fuel.id, payee: 'Shell', memo: t.description });
  assert.strictEqual(await bal('6100'), fuel0 + 12840);
  assert.strictEqual(await bal('1001'), bank0 - 12840);
  const office = review.find((t) => /OFFICE DEPOT/.test(t.description));
  assert.strictEqual(office.description, 'OFFICE DEPOT #2201, SUPPLIES', 'quoted CSV field with a comma');
  const officeAcct = await db.prepare("SELECT id FROM accounts WHERE code = '6400'").get();
  await acct.post(`/accounting/banking/${bankId}/txn/${office.id}/add`, { category_id: officeAcct.id, payee: 'Office Depot', make_rule: '1', rule_text: 'OFFICE DEPOT' });
  assert.ok(await db.prepare("SELECT id FROM bank_rules WHERE match_text = 'OFFICE DEPOT'").get(), 'rule created from the review screen');
  const fee = review.find((t) => /SERVICE FEE/.test(t.description));
  await acct.post(`/accounting/banking/${bankId}/txn/${fee.id}/exclude`, {});
  // Undo an added one: the entry is reversed, the line returns to review.
  await acct.post(`/accounting/banking/${bankId}/txn/${office.id}/undo`, {});
  assert.strictEqual((await db.prepare('SELECT status FROM bank_transactions WHERE id = ?').get(office.id)).status, 'review');
  await acct.post(`/accounting/banking/${bankId}/txn/${office.id}/add`, { category_id: officeAcct.id, payee: 'Office Depot' });
  assert.strictEqual((await banking.forReview(bankId)).length, 0);
  const reg = await acct.get(`/accounting/accounts/${bankId}/register?from=${fmt.addDays(today, -60)}`);
  assert.match(reg.text, /Opening balance - Demo Checking/);
  assert.match(reg.text, /\$10,000\.00/);
});

test('reconcile to the statement; finishing requires a zero difference; undo', async () => {
  const bankId = state.bank.id;
  const statementBal = await bal('1001');
  const r = await acct.post(`/accounting/banking/${bankId}/reconcile`, { statement_date: today, statement_balance: fmt.centsInput(statementBal) });
  const rid = idFrom(r.url, '/accounting/reconcile');
  assert.ok(rid);
  const banking = require('../utils/banking');
  const rec = await banking.reconciliation(rid);
  const ids = rec.lines.map((l) => l.id);
  assert.match(flashOf(await acct.post(`/accounting/reconcile/${rid}`, { line_ids: ids.slice(1), finish: '1' })), /difference must be \$0\.00/);
  const done = await acct.post(`/accounting/reconcile/${rid}`, { line_ids: ids, finish: '1' });
  assert.match(flashOf(done), /Reconciled through/);
  assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM journal_lines WHERE reconciliation_id = ?').get(rid)).c, ids.length);
  // A reconciled bank line can't be un-matched.
  const matched = await db.prepare("SELECT id FROM bank_transactions WHERE account_id = ? AND status = 'matched'").get(bankId);
  assert.match(flashOf(await acct.post(`/accounting/banking/${bankId}/txn/${matched.id}/undo`, {})), /reconciled/);
  assert.match(flashOf(await acct.post(`/accounting/banking/${bankId}/reconcile`, { statement_date: fmt.addDays(today, -1), statement_balance: '1' })), /already reconciled/);
  await acct.post(`/accounting/reconcile/${rid}/undo`, {});
  assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM journal_lines WHERE reconciliation_id = ?').get(rid)).c, 0);
});

test('closing the books blocks earlier postings; reopening allows them', async () => {
  const fuel = await db.prepare("SELECT id FROM accounts WHERE code = '6100'").get();
  const yesterday = fmt.addDays(today, -1);
  assert.match(flashOf(await acct.post('/accounting/close', { closed_through: today })), /periods that have ended/);
  await acct.post('/accounting/close', { closed_through: yesterday });
  const blocked = await acct.post('/expenses', { expense_date: yesterday, payee: 'Late receipt', account_id: fuel.id, paid_from: '1000', amount: '10' });
  assert.match(flashOf(blocked), /books are closed through/);
  const ok = await acct.post('/expenses', { expense_date: today, payee: 'Today receipt', account_id: fuel.id, paid_from: '1000', amount: '10' });
  assert.match(flashOf(ok), /recorded/);
  await acct.post('/accounting/close', { clear: '1' });
  assert.match(flashOf(await acct.post('/expenses', { expense_date: yesterday, payee: 'Late receipt', account_id: fuel.id, paid_from: '1000', amount: '10' })), /recorded/);
});

test('customer statement and the new reports', async () => {
  // Bill a customer and take a partial payment.
  const c = await db.prepare("SELECT id FROM customers WHERE name = 'Luis Romero'").get();
  const r = await acct.post('/invoices/new', { customer_id: c.id });
  const invId = idFrom(r.url, '/invoices');
  await acct.post(`/invoices/${invId}/lines`, { kind: 'labor', description: 'Service call', quantity: 1, unit_price: '200', taxable: '' });
  await acct.post(`/invoices/${invId}/issue`, { issue_date: today });
  await acct.post(`/invoices/${invId}/payments`, { amount: '75.00', method: 'check', received_on: today });
  const st = await acct.get(`/invoices/statement/${c.id}`);
  assert.strictEqual(st.status, 200);
  assert.match(st.text, /Amount due[\s\S]*\$125\.00/);
  for (const url of ['/accounting/reports/general-ledger', '/accounting/reports/sales-by-customer', '/accounting/reports/expenses-by-payee', '/accounting/reports/balance-sheet', '/accounting/reports/general-ledger?format=csv', '/accounting/reports/sales-by-customer?format=csv', '/accounting/reports/expenses-by-payee?format=csv']) {
    assert.strictEqual((await acct.get(url)).status, 200, url);
  }
  const sales = await require('../utils/accounting').salesByCustomer(fmt.addDays(today, -1), today);
  assert.ok(sales.some((s) => s.id === c.id && s.net === 20000 && s.open === 12500));
  const payees = await require('../utils/accounting').expensesByPayee(fmt.addDays(today, -30), today);
  assert.ok(payees.some((p) => p.name === 'Shell' && p.total === 12840));
  const bs = await require('../utils/accounting').balanceSheet(today);
  assert.ok(bs.balanced);
  assert.strictEqual(bs.priorEarnings + bs.currentEarnings, bs.earnings);
  const tb = await require('../utils/accounting').trialBalance(today);
  assert.strictEqual(tb.totalDebit, tb.totalCredit);
});

test('employee portal shows my jobs, pay, leave and training in one place', async () => {
  const t = new Client(ctx.base);
  await t.login('lead@hvacdemo.test');
  const home = await t.get('/employee');
  assert.strictEqual(home.status, 200);
  for (const s of ["Today's jobs", 'My pay', 'Leave balance', 'Training due', 'My certifications', 'Time clock']) assert.match(home.text, new RegExp(s), s);
  for (const url of ['/employee/jobs', '/employee/time', '/employee/pay', '/employee/time-off', '/employee/truck', '/employee/report', '/training/mine']) assert.strictEqual((await t.get(url)).status, 200, url);
  assert.strictEqual((await t.get('/accounting')).status, 403);
});
