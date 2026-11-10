// Banking, QuickBooks-style:
//  - bank & credit card accounts (accounts.subtype 'bank' / 'credit_card')
//  - registers with running balances
//  - statement import (CSV from any bank) -> "For review" list, where each
//    line is MATCHED to something already in the books (a customer
//    payment, bill payment, expense...), ADDED as a new categorized
//    entry, or EXCLUDED. Re-importing the same file never duplicates.
//  - rules that pre-fill the category ("SHELL" -> 6100 Fuel)
//  - transfers between accounts (e.g. paying down the credit card)
//  - reconciliation against the statement's ending balance
const crypto = require('crypto');
const db = require('../db');
const fmt = require('./format');
const accounting = require('./accounting');

const SUBTYPES = { bank: 'Bank account', credit_card: 'Credit card' };

async function bankAccounts() {
  const accts = await db.prepare("SELECT * FROM accounts WHERE subtype IN ('bank','credit_card') AND active = 1 ORDER BY subtype, code").all();
  const bals = await accounting.balances();
  for (const a of accts) {
    a.balance = (bals.find((b) => b.id === a.id) || { balance: 0 }).balance;
    a.toReview = (await db.prepare("SELECT COUNT(*) AS c FROM bank_transactions WHERE account_id = ? AND status = 'review'").get(a.id)).c;
    const lastRec = await db.prepare("SELECT statement_date, statement_balance_cents FROM bank_reconciliations WHERE account_id = ? AND status = 'completed' ORDER BY statement_date DESC, id DESC LIMIT 1").get(a.id);
    a.lastReconciled = lastRec || null;
  }
  return accts;
}

async function bankAccount(id) {
  const a = await db.prepare("SELECT * FROM accounts WHERE id = ? AND subtype IN ('bank','credit_card')").get(id);
  if (!a) throw new Error('Bank or credit card account not found.');
  return a;
}

async function addBankAccount({ name, subtype, last4, openingBalanceCents, openingDate }, memberId) {
  const n = fmt.clean(name, 100);
  if (!n) throw new Error('Name the account (e.g. "Chase Business Checking").');
  if (!SUBTYPES[subtype]) throw new Error('Choose bank account or credit card.');
  const prefix = subtype === 'bank' ? 10 : 24;
  const used = new Set((await db.prepare('SELECT code FROM accounts').all()).map((r) => r.code));
  let code = null;
  for (let i = 1; i < 100 && !code; i++) if (!used.has(`${prefix}${String(i).padStart(2, '0')}`)) code = `${prefix}${String(i).padStart(2, '0')}`;
  if (!code) throw new Error('No free account numbers left.');
  return db.withTransaction(async (tx) => {
    const info = await tx.prepare('INSERT INTO accounts (code, name, type, subtype, account_last4) VALUES (?, ?, ?, ?, ?)').run(code, n, subtype === 'bank' ? 'asset' : 'liability', subtype, fmt.clean(last4, 4));
    if (openingBalanceCents) {
      // Opening balance comes from owner's equity (as QuickBooks does).
      const amt = Math.abs(openingBalanceCents);
      const positive = openingBalanceCents > 0;
      const lines = subtype === 'bank'
        ? (positive ? [{ accountId: info.lastInsertRowid, debit: amt }, { code: '3000', credit: amt }] : [{ code: '3000', debit: amt }, { accountId: info.lastInsertRowid, credit: amt }])
        : (positive ? [{ code: '3000', debit: amt }, { accountId: info.lastInsertRowid, credit: amt }] : [{ accountId: info.lastInsertRowid, debit: amt }, { code: '3000', credit: amt }]);
      await accounting.post(tx, { date: openingDate || fmt.today(), memo: `Opening balance - ${n}`, sourceType: 'opening_balance', sourceId: info.lastInsertRowid, memberId, lines });
    }
    return info.lastInsertRowid;
  });
}

// Signed so that money IN to a bank account (or charges reducing a card
// balance... see below) reads naturally: for bank accounts +deposit
// -withdrawal; for credit cards +payment/credit -charge.
function signedAmount(line) {
  return line.debit_cents - line.credit_cents;
}

async function register(accountId, { from = null, to = null } = {}) {
  const acct = await bankAccountOrAny(accountId);
  const normalDebit = accounting.DEBIT_NORMAL.has(acct.type);
  const opening = from
    ? (await accounting.balances({ to: fmt.addDays(from, -1) })).find((r) => r.id === acct.id).balance
    : 0;
  const params = [acct.id];
  let where = 'jl.account_id = ?';
  if (from) { where += ' AND je.entry_date >= ?'; params.push(from); }
  if (to) { where += ' AND je.entry_date <= ?'; params.push(to); }
  const lines = await db
    .prepare(`SELECT jl.*, je.entry_date, je.memo, je.source_type, je.source_id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE ${where} ORDER BY je.entry_date, je.id, jl.id`)
    .all(...params);
  // Counter-account names for each entry (the "split" column).
  const entryIds = [...new Set(lines.map((l) => l.entry_id))];
  const others = entryIds.length
    ? await db.prepare(`SELECT jl.entry_id, a.code, a.name FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id IN (${entryIds.map(() => '?').join(',')}) AND jl.account_id <> ?`).all(...entryIds, acct.id)
    : [];
  let bal = opening;
  const rows = lines.map((l) => {
    const change = normalDebit ? l.debit_cents - l.credit_cents : l.credit_cents - l.debit_cents;
    bal += change;
    const o = others.filter((x) => x.entry_id === l.entry_id);
    return { ...l, change, balance: bal, split: o.length === 1 ? `${o[0].code} ${o[0].name}` : o.length ? '-Split-' : '' };
  });
  return { account: acct, opening, rows, closing: bal };
}

async function bankAccountOrAny(id) {
  const a = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!a) throw new Error('Account not found.');
  return a;
}

// ---------------------------------------------------------------- CSV import
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

function parseDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function parseMoney(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  s = s.replace(/[()$,\s-]/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const c = Math.round(Number(s) * 100);
  return neg ? -c : c;
}

// Finds the date / description / amount (or debit+credit) columns.
function mapColumns(header) {
  const h = header.map((x) => String(x).toLowerCase().trim());
  const find = (...names) => h.findIndex((x) => names.some((n) => x === n || x.includes(n)));
  const cols = {
    date: find('posting date', 'transaction date', 'date', 'posted'),
    desc: find('description', 'payee', 'memo', 'details', 'name'),
    amount: h.findIndex((x) => x === 'amount' || x === 'transaction amount' || x === 'amount ($)'),
    debit: find('debit', 'withdrawal', 'money out', 'charges'),
    credit: find('credit', 'deposit', 'money in', 'payments'),
  };
  if (cols.date < 0 || cols.desc < 0 || (cols.amount < 0 && cols.debit < 0 && cols.credit < 0)) {
    throw new Error('Could not find Date, Description and Amount (or Debit/Credit) columns. Download the CSV from your bank and upload it unchanged.');
  }
  return cols;
}

// For credit cards, banks export charges as positive or negative depending
// on the bank; flip_sign lets the user fix that on import.
async function importCsv(accountId, text, { fileName, flipSign = false }, memberId) {
  const acct = await bankAccount(accountId);
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file has no transactions.');
  const cols = mapColumns(rows[0]);
  let added = 0;
  let skipped = 0;
  const seen = {};
  const info = await db.prepare('INSERT INTO bank_imports (account_id, file_name, created_by) VALUES (?, ?, ?)').run(acct.id, fmt.clean(fileName, 200), memberId);
  for (const r of rows.slice(1)) {
    const date = parseDate(r[cols.date]);
    const desc = fmt.clean(r[cols.desc], 300);
    let amount = cols.amount >= 0 ? parseMoney(r[cols.amount]) : null;
    if (amount === null) {
      const d = cols.debit >= 0 ? parseMoney(r[cols.debit]) : null;
      const c = cols.credit >= 0 ? parseMoney(r[cols.credit]) : null;
      if (d === null && c === null) { skipped++; continue; }
      amount = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
    }
    if (!date || !desc || !amount) { skipped++; continue; }
    if (flipSign) amount = -amount;
    // Same date+amount+description twice in one file are two real
    // transactions; the occurrence number keeps them distinct.
    const key = `${acct.id}|${date}|${amount}|${desc.toLowerCase()}`;
    seen[key] = (seen[key] || 0) + 1;
    const fingerprint = crypto.createHash('sha256').update(`${key}|${seen[key]}`).digest('hex');
    const r2 = await db
      .prepare('INSERT INTO bank_transactions (account_id, import_id, txn_date, description, amount_cents, fingerprint) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (fingerprint) DO NOTHING')
      .run(acct.id, info.lastInsertRowid, date, desc, amount, fingerprint);
    if (r2.changes) added++; else skipped++;
  }
  await db.prepare('UPDATE bank_imports SET rows_added = ?, rows_skipped = ? WHERE id = ?').run(added, skipped, info.lastInsertRowid);
  return { added, skipped };
}

// ---------------------------------------------------------------- review
async function rules() {
  return db.prepare('SELECT r.*, a.code, a.name AS "accountName" FROM bank_rules r JOIN accounts a ON a.id = r.account_id ORDER BY r.match_text').all();
}

async function addRule({ matchText, direction, accountId, payee }, memberId) {
  const m = fmt.clean(matchText, 100);
  if (!m) throw new Error('Enter the text to look for in the bank description.');
  if (!(await db.prepare('SELECT id FROM accounts WHERE id = ? AND active = 1').get(accountId))) throw new Error('Choose a category.');
  await db.prepare('INSERT INTO bank_rules (match_text, direction, account_id, payee, created_by) VALUES (?, ?, ?, ?, ?)').run(m, ['money_in', 'money_out'].includes(direction) ? direction : 'any', accountId, fmt.clean(payee, 100), memberId);
}

async function deleteRule(id) {
  await db.prepare('DELETE FROM bank_rules WHERE id = ?').run(id);
}

// "For review" list with a suggested match or category for each line.
async function forReview(accountId) {
  const acct = await bankAccount(accountId);
  const txns = await db.prepare("SELECT * FROM bank_transactions WHERE account_id = ? AND status = 'review' ORDER BY txn_date, id").all(acct.id);
  const allRules = await rules();
  const used = new Set((await db.prepare('SELECT matched_line_id FROM bank_transactions WHERE matched_line_id IS NOT NULL').all()).map((r) => r.matched_line_id));
  for (const t of txns) {
    // Match: an existing, unmatched line on this account with the same
    // amount within 7 days (e.g. the payment recorded from an invoice).
    const candidates = await db
      .prepare(`SELECT jl.id, jl.debit_cents, jl.credit_cents, je.entry_date, je.memo FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_id = ? AND jl.reconciliation_id IS NULL AND je.entry_date >= ? AND je.entry_date <= ? AND (jl.debit_cents - jl.credit_cents) = ?`)
      .all(acct.id, fmt.addDays(t.txn_date, -7), fmt.addDays(t.txn_date, 7), t.amount_cents);
    t.matches = candidates.filter((c) => !used.has(c.id));
    const desc = t.description.toLowerCase();
    t.rule = allRules.find((r) => desc.includes(r.match_text.toLowerCase()) && (r.direction === 'any' || (r.direction === 'money_in') === (t.amount_cents > 0))) || null;
  }
  return txns;
}

async function lockTxn(tx, id, accountId) {
  const t = await tx.prepare("SELECT * FROM bank_transactions WHERE id = ? AND account_id = ? AND status = 'review'").get(id, accountId);
  if (!t) throw new Error('That transaction was already handled.');
  return t;
}

async function match(accountId, txnId, lineId, memberId) {
  return db.withTransaction(async (tx) => {
    const t = await lockTxn(tx, txnId, accountId);
    const l = await tx.prepare('SELECT * FROM journal_lines WHERE id = ? AND account_id = ?').get(lineId, accountId);
    if (!l || signedAmount(l) !== t.amount_cents) throw new Error('That entry does not match this transaction.');
    const dup = await tx.prepare('SELECT id FROM bank_transactions WHERE matched_line_id = ?').get(lineId);
    if (dup) throw new Error('That entry is already matched to another bank transaction.');
    await tx.prepare("UPDATE bank_transactions SET status = 'matched', matched_line_id = ?, journal_entry_id = ?, decided_by = ?, decided_at = now_text() WHERE id = ?").run(lineId, l.entry_id, memberId, txnId);
  });
}

// Records a new entry: money in -> Dr bank / Cr category; money out -> Dr category / Cr bank.
async function add(accountId, txnId, { categoryId, payee, memo }, memberId) {
  return db.withTransaction(async (tx) => {
    const t = await lockTxn(tx, txnId, accountId);
    const cat = await tx.prepare('SELECT * FROM accounts WHERE id = ? AND active = 1').get(categoryId);
    if (!cat) throw new Error('Choose a category.');
    if (cat.id === accountId) throw new Error('Choose a different account than the bank account itself.');
    const amt = Math.abs(t.amount_cents);
    const lines = t.amount_cents > 0 ? [{ accountId, debit: amt }, { accountId: cat.id, credit: amt }] : [{ accountId: cat.id, debit: amt }, { accountId, credit: amt }];
    const entryId = await accounting.post(tx, { date: t.txn_date, memo: [fmt.clean(payee, 100), fmt.clean(memo, 200) || t.description].filter(Boolean).join(' - '), sourceType: 'bank_feed', sourceId: t.id, memberId, lines });
    const line = await tx.prepare('SELECT id FROM journal_lines WHERE entry_id = ? AND account_id = ?').get(entryId, accountId);
    await tx.prepare("UPDATE bank_transactions SET status = 'added', journal_entry_id = ?, matched_line_id = ?, decided_by = ?, decided_at = now_text() WHERE id = ?").run(entryId, line.id, memberId, txnId);
    return entryId;
  });
}

async function exclude(accountId, txnId, memberId) {
  return db.withTransaction(async (tx) => {
    await lockTxn(tx, txnId, accountId);
    await tx.prepare("UPDATE bank_transactions SET status = 'excluded', decided_by = ?, decided_at = now_text() WHERE id = ?").run(memberId, txnId);
  });
}

// Puts a handled transaction back into review; an entry created from it
// is reversed (never deleted), a match is simply released.
async function undo(accountId, txnId, memberId) {
  return db.withTransaction(async (tx) => {
    const t = await tx.prepare("SELECT * FROM bank_transactions WHERE id = ? AND account_id = ? AND status IN ('matched','added','excluded')").get(txnId, accountId);
    if (!t) throw new Error('Transaction not found.');
    if (t.matched_line_id) {
      const l = await tx.prepare('SELECT reconciliation_id FROM journal_lines WHERE id = ?').get(t.matched_line_id);
      if (l && l.reconciliation_id) throw new Error('It has been reconciled. Undo the reconciliation first.');
    }
    if (t.status === 'added') await accounting.reverse(tx, t.journal_entry_id, { memo: `Undo bank entry: ${t.description}`, memberId });
    await tx.prepare("UPDATE bank_transactions SET status = 'review', journal_entry_id = NULL, matched_line_id = NULL, decided_by = NULL, decided_at = NULL WHERE id = ?").run(txnId);
  });
}

async function handled(accountId, limit = 100) {
  return db
    .prepare(`SELECT t.*, m.name AS "byName" FROM bank_transactions t LEFT JOIN members m ON m.id = t.decided_by WHERE t.account_id = ? AND t.status <> 'review' ORDER BY t.decided_at DESC, t.id DESC LIMIT ${Math.min(parseInt(limit, 10) || 100, 500)}`)
    .all(accountId);
}

// ---------------------------------------------------------------- transfers
async function transfer({ fromId, toId, amountCents, date, memo }, memberId) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Enter the amount.');
  if (String(fromId) === String(toId)) throw new Error('Choose two different accounts.');
  const from = await bankAccount(fromId);
  const to = await bankAccount(toId);
  return db.withTransaction((tx) => accounting.post(tx, {
    date: fmt.dateOnly(date) || fmt.today(), memo: fmt.clean(memo, 200) || `Transfer from ${from.name} to ${to.name}`, sourceType: 'transfer', memberId,
    lines: [{ accountId: to.id, debit: amountCents }, { accountId: from.id, credit: amountCents }],
  }));
}

// ---------------------------------------------------------------- reconciliation
// Beginning balance = statement balance of the last completed
// reconciliation (0 for the first one). Amounts are in "statement terms":
// a bank's balance is debits-credits; a card's balance owed is credits-debits.
function stmtSign(acct) {
  return acct.subtype === 'credit_card' ? -1 : 1;
}

async function startReconciliation(accountId, { statementDate, statementBalanceCents }, memberId) {
  const acct = await bankAccount(accountId);
  const date = fmt.dateOnly(statementDate);
  if (!date) throw new Error('Enter the statement ending date.');
  if (!Number.isInteger(statementBalanceCents)) throw new Error('Enter the statement ending balance.');
  const open = await db.prepare("SELECT id FROM bank_reconciliations WHERE account_id = ? AND status = 'in_progress'").get(acct.id);
  if (open) return open.id;
  const last = await db.prepare("SELECT * FROM bank_reconciliations WHERE account_id = ? AND status = 'completed' ORDER BY statement_date DESC, id DESC LIMIT 1").get(acct.id);
  if (last && date <= last.statement_date) throw new Error(`This account is already reconciled through ${fmt.d(last.statement_date)}.`);
  const info = await db
    .prepare('INSERT INTO bank_reconciliations (account_id, statement_date, statement_balance_cents, beginning_balance_cents, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(acct.id, date, statementBalanceCents, last ? last.statement_balance_cents : 0, memberId);
  return info.lastInsertRowid;
}

async function reconciliation(id) {
  const r = await db.prepare('SELECT r.*, a.name AS "accountName", a.subtype, a.code FROM bank_reconciliations r JOIN accounts a ON a.id = r.account_id WHERE r.id = ?').get(id);
  if (!r) return null;
  const acct = await bankAccount(r.account_id);
  const sign = stmtSign(acct);
  const lines = await db
    .prepare(`SELECT jl.*, je.entry_date, je.memo FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_id = ? AND je.entry_date <= ? AND (jl.reconciliation_id IS NULL OR jl.reconciliation_id = ?) ORDER BY je.entry_date, jl.id`)
    .all(acct.id, r.statement_date, r.id);
  for (const l of lines) l.amount = sign * (l.debit_cents - l.credit_cents);
  const cleared = lines.filter((l) => l.reconciliation_id === r.id).reduce((s, l) => s + l.amount, 0);
  r.lines = lines;
  r.clearedBalance = r.beginning_balance_cents + cleared;
  r.difference = r.statement_balance_cents - r.clearedBalance;
  return r;
}

async function setCleared(id, lineIds, memberId) {
  return db.withTransaction(async (tx) => {
    const r = await tx.prepare("SELECT * FROM bank_reconciliations WHERE id = ? AND status = 'in_progress'").get(id);
    if (!r) throw new Error('This reconciliation is not open.');
    await tx.prepare('UPDATE journal_lines SET reconciliation_id = NULL WHERE reconciliation_id = ?').run(id);
    for (const lid of lineIds) {
      await tx
        .prepare('UPDATE journal_lines SET reconciliation_id = ? WHERE id = ? AND account_id = ? AND reconciliation_id IS NULL AND entry_id IN (SELECT id FROM journal_entries WHERE entry_date <= ?)')
        .run(id, lid, r.account_id, r.statement_date);
    }
    void memberId;
  });
}

async function finishReconciliation(id, memberId) {
  const r = await reconciliation(id);
  if (!r || r.status !== 'in_progress') throw new Error('This reconciliation is not open.');
  if (r.difference !== 0) throw new Error(`The difference must be $0.00 to finish (it is ${fmt.money(r.difference)}). Check for missing or extra transactions.`);
  await db.prepare("UPDATE bank_reconciliations SET status = 'completed', completed_at = now_text() WHERE id = ?").run(id);
  void memberId;
}

async function undoReconciliation(id) {
  const r = await db.prepare('SELECT * FROM bank_reconciliations WHERE id = ?').get(id);
  if (!r || r.status === 'undone') throw new Error('Reconciliation not found.');
  const later = await db.prepare("SELECT id FROM bank_reconciliations WHERE account_id = ? AND status = 'completed' AND statement_date > ?").get(r.account_id, r.statement_date);
  if (later) throw new Error('Undo the later reconciliations first.');
  await db.withTransaction(async (tx) => {
    await tx.prepare('UPDATE journal_lines SET reconciliation_id = NULL WHERE reconciliation_id = ?').run(id);
    await tx.prepare("UPDATE bank_reconciliations SET status = 'undone' WHERE id = ?").run(id);
  });
}

async function reconciliationHistory(accountId) {
  return db.prepare('SELECT r.*, m.name AS "byName" FROM bank_reconciliations r LEFT JOIN members m ON m.id = r.created_by WHERE r.account_id = ? ORDER BY r.statement_date DESC, r.id DESC').all(accountId);
}

module.exports = {
  SUBTYPES, bankAccounts, bankAccount, addBankAccount, register, parseCsv, parseDate, parseMoney, importCsv, rules, addRule, deleteRule, forReview,
  match, add, exclude, undo, handled, transfer, startReconciliation, reconciliation, setCleared, finishReconciliation, undoReconciliation, reconciliationHistory,
};
