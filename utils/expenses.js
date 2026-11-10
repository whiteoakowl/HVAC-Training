// Expenses paid directly (fuel, insurance, utilities, office...) with
// optional receipt image, and recurring expense templates. Each expense
// posts Dr <expense account> / Cr <paid-from account>; voiding reverses
// it. Recurring expenses are NEVER posted automatically - the daily job
// only reminds accounting, and a person posts each one.
const db = require('../db');
const fmt = require('./format');
const accounting = require('./accounting');

// Where the money came from.
const PAID_FROM = { 1000: 'Cash / checking', 2400: 'Company credit card', 3000: 'Owner paid personally (contribution)' };
const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annual'];

async function expenseAccounts() {
  return db.prepare("SELECT * FROM accounts WHERE active = 1 AND type IN ('expense','cogs') ORDER BY code").all();
}

async function list({ from, to, accountId = null, jobId = null } = {}) {
  const where = ['e.expense_date >= ?', 'e.expense_date <= ?'];
  const params = [from, to];
  if (accountId) { where.push('e.account_id = ?'); params.push(accountId); }
  if (jobId) { where.push('e.job_id = ?'); params.push(jobId); }
  return db
    .prepare(`SELECT e.id, e.expense_date, e.payee, e.amount_cents, e.description, e.status, e.paid_from_code, e.job_id, e.truck_id, e.receipt_name, e.journal_entry_id,
        a.code, a.name AS "accountName", j.job_number, t.name AS "truckName", m.name AS "memberName"
      FROM expenses e JOIN accounts a ON a.id = e.account_id LEFT JOIN jobs j ON j.id = e.job_id LEFT JOIN trucks t ON t.id = e.truck_id LEFT JOIN members m ON m.id = e.member_id
      WHERE ${where.join(' AND ')} ORDER BY e.expense_date DESC, e.id DESC`)
    .all(...params);
}

async function record(d, memberId, tx = null) {
  const amount = d.amountCents;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter the amount.');
  const payee = fmt.clean(d.payee, 200);
  if (!payee) throw new Error('Who was paid?');
  if (!PAID_FROM[d.paidFrom]) throw new Error('Choose how it was paid.');
  const body = async (t) => {
    const acct = await t.prepare("SELECT * FROM accounts WHERE id = ? AND active = 1 AND type IN ('expense','cogs')").get(d.accountId);
    if (!acct) throw new Error('Choose an expense category.');
    const date = fmt.dateOnly(d.date) || fmt.today();
    const info = await t
      .prepare(`INSERT INTO expenses (expense_date, payee, vendor_id, account_id, paid_from_code, amount_cents, description, job_id, truck_id, member_id, recurring_expense_id, receipt, receipt_name, receipt_mime, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(date, payee, d.vendorId || null, acct.id, String(d.paidFrom), amount, fmt.clean(d.description, 1000), d.jobId || null, d.truckId || null, d.memberId || null, d.recurringId || null,
        d.receipt ? d.receipt.buffer : null, d.receipt ? String(d.receipt.originalname).slice(0, 200) : null, d.receipt ? d.receipt.mimetype : null, memberId);
    const entryId = await accounting.post(t, {
      date, memo: `Expense: ${payee}${d.description ? ' - ' + fmt.clean(d.description, 100) : ''}`, sourceType: 'expense', sourceId: info.lastInsertRowid, memberId,
      lines: [{ accountId: acct.id, debit: amount }, { code: String(d.paidFrom), credit: amount }],
    });
    await t.prepare('UPDATE expenses SET journal_entry_id = ? WHERE id = ?').run(entryId, info.lastInsertRowid);
    return info.lastInsertRowid;
  };
  return tx ? body(tx) : db.withTransaction(body);
}

async function voidExpense(id, reason, memberId) {
  if (!fmt.clean(reason)) throw new Error('A reason is required.');
  return db.withTransaction(async (tx) => {
    const e = await tx.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!e || e.status === 'void') throw new Error('Expense not found or already void.');
    await accounting.reverse(tx, e.journal_entry_id, { memo: `Void expense #${id}: ${reason}`, memberId });
    await tx.prepare("UPDATE expenses SET status = 'void', description = COALESCE(description, '') || ? WHERE id = ?").run(` [Void: ${reason}]`, id);
  });
}

function nextDate(date, frequency) {
  const d = new Date(date + 'T00:00:00Z');
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  if (frequency === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  if (frequency === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

async function listRecurring() {
  return db.prepare('SELECT r.*, a.code, a.name AS "accountName" FROM recurring_expenses r JOIN accounts a ON a.id = r.account_id ORDER BY r.active DESC, r.next_due').all();
}

async function dueRecurring(onOrBefore = fmt.today()) {
  return db.prepare('SELECT r.*, a.name AS "accountName" FROM recurring_expenses r JOIN accounts a ON a.id = r.account_id WHERE r.active = 1 AND r.next_due <= ? ORDER BY r.next_due').all(onOrBefore);
}

async function saveRecurring(d) {
  const amount = d.amountCents;
  if (!fmt.clean(d.payee)) throw new Error('Payee is required.');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter the amount.');
  if (!FREQUENCIES.includes(d.frequency)) throw new Error('Choose how often.');
  if (!PAID_FROM[d.paidFrom]) throw new Error('Choose how it is paid.');
  if (!fmt.dateOnly(d.nextDue)) throw new Error('Enter the next due date.');
  const acct = await db.prepare("SELECT id FROM accounts WHERE id = ? AND type IN ('expense','cogs')").get(d.accountId);
  if (!acct) throw new Error('Choose an expense category.');
  await db
    .prepare('INSERT INTO recurring_expenses (payee, account_id, paid_from_code, amount_cents, frequency, next_due, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(fmt.clean(d.payee, 200), acct.id, String(d.paidFrom), amount, d.frequency, fmt.dateOnly(d.nextDue), fmt.clean(d.description, 500));
}

// A person confirms each occurrence (amount can differ, e.g. utilities).
async function postRecurring(id, { amountCents, date }, memberId) {
  return db.withTransaction(async (tx) => {
    const r = await tx.prepare('SELECT * FROM recurring_expenses WHERE id = ? AND active = 1').get(id);
    if (!r) throw new Error('Recurring expense not found.');
    const expenseId = await record({ date: date || r.next_due, payee: r.payee, accountId: r.account_id, paidFrom: r.paid_from_code, amountCents: amountCents || r.amount_cents, description: r.description, recurringId: r.id }, memberId, tx);
    await tx.prepare('UPDATE recurring_expenses SET next_due = ? WHERE id = ?').run(nextDate(r.next_due, r.frequency), r.id);
    return expenseId;
  });
}

async function setRecurringActive(id, active) {
  await db.prepare('UPDATE recurring_expenses SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

module.exports = { PAID_FROM, FREQUENCIES, expenseAccounts, list, record, voidExpense, listRecurring, dueRecurring, saveRecurring, postRecurring, setRecurringActive, nextDate };
