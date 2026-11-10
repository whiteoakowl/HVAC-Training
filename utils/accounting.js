// Double-entry general ledger. Every financial event (invoice issued,
// payment received, inventory received/used/adjusted, manual entry)
// posts a balanced journal entry; every report below is computed from
// journal_lines - never from dashboard totals or invoice rows - so the
// numbers always reconcile with the audit trail. Entries are never
// edited or deleted: mistakes are corrected with a reversing entry.
const db = require('../db');
const fmt = require('./format');

const TYPES = ['asset', 'liability', 'equity', 'income', 'cogs', 'expense'];
const DEBIT_NORMAL = new Set(['asset', 'cogs', 'expense']);

async function listAccounts({ activeOnly = false } = {}) {
  return db.prepare(`SELECT * FROM accounts ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY code`).all();
}

async function accountByCode(code, tx = db) {
  const a = await tx.prepare('SELECT * FROM accounts WHERE code = ?').get(String(code));
  if (!a) throw new Error(`Account ${code} is missing from the chart of accounts.`);
  return a;
}

// lines: [{ code | accountId, debit, credit, description }] in cents.
async function post(tx, { date, memo, sourceType = 'manual', sourceId = null, lines, memberId = null, reversesEntryId = null }) {
  const clean = [];
  for (const l of lines) {
    const debit = Math.round(Number(l.debit || 0));
    const credit = Math.round(Number(l.credit || 0));
    if (debit < 0 || credit < 0) throw new Error('Debits and credits must be positive amounts.');
    if (debit === 0 && credit === 0) continue;
    const accountId = l.accountId || (await accountByCode(l.code, tx)).id;
    clean.push({ accountId, debit, credit, description: l.description || null });
  }
  const dr = clean.reduce((s, l) => s + l.debit, 0);
  const cr = clean.reduce((s, l) => s + l.credit, 0);
  if (!clean.length || dr === 0) throw new Error('A journal entry needs at least one non-zero line.');
  if (dr !== cr) throw new Error(`Journal entry is out of balance: debits ${fmt.money(dr)} vs credits ${fmt.money(cr)}.`);
  const info = await tx
    .prepare('INSERT INTO journal_entries (entry_date, memo, source_type, source_id, reverses_entry_id, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(fmt.dateOnly(date) || fmt.today(), memo, sourceType, sourceId, reversesEntryId, memberId);
  for (const l of clean) {
    await tx.prepare('INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents, description) VALUES (?, ?, ?, ?, ?)').run(info.lastInsertRowid, l.accountId, l.debit, l.credit, l.description);
  }
  return info.lastInsertRowid;
}

async function reverse(tx, entryId, { memo, memberId, date } = {}) {
  const entry = await tx.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  if (!entry) throw new Error('Journal entry not found.');
  const already = await tx.prepare('SELECT id FROM journal_entries WHERE reverses_entry_id = ?').get(entryId);
  if (already) throw new Error('That entry has already been reversed.');
  const lines = await tx.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(entryId);
  return post(tx, {
    date: date || fmt.today(),
    memo: memo || `Reversal of entry #${entryId}: ${entry.memo}`,
    sourceType: entry.source_type,
    sourceId: entry.source_id,
    reversesEntryId: entryId,
    memberId,
    lines: lines.map((l) => ({ accountId: l.account_id, debit: l.credit_cents, credit: l.debit_cents, description: l.description })),
  });
}

async function getEntry(id) {
  const entry = await db.prepare('SELECT je.*, m.name AS "createdByName" FROM journal_entries je LEFT JOIN members m ON m.id = je.created_by WHERE je.id = ?').get(id);
  if (!entry) return null;
  entry.lines = await db.prepare('SELECT jl.*, a.code, a.name AS "accountName" FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? ORDER BY jl.id').all(id);
  entry.reversedBy = await db.prepare('SELECT id FROM journal_entries WHERE reverses_entry_id = ?').get(id);
  return entry;
}

async function listEntries({ from = null, to = null, accountId = null, limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('je.entry_date >= ?'); params.push(from); }
  if (to) { where.push('je.entry_date <= ?'); params.push(to); }
  if (accountId) { where.push('je.id IN (SELECT entry_id FROM journal_lines WHERE account_id = ?)'); params.push(accountId); }
  const max = Math.min(parseInt(limit, 10) || 300, 2000);
  return db
    .prepare(`SELECT je.*, (SELECT SUM(debit_cents) FROM journal_lines WHERE entry_id = je.id) AS "amount" FROM journal_entries je ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY je.entry_date DESC, je.id DESC LIMIT ${max}`)
    .all(...params);
}

// Sum of debits/credits per account for entries dated within [from, to]
// (either bound optional). balance is signed in the account's normal
// direction (positive = normal).
async function balances({ from = null, to = null } = {}) {
  const cond = [];
  const params = [];
  if (from) { cond.push('je.entry_date >= ?'); params.push(from); }
  if (to) { cond.push('je.entry_date <= ?'); params.push(to); }
  const rows = await db
    .prepare(`SELECT a.id, a.code, a.name, a.type, a.active,
        COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_cents ELSE 0 END), 0) AS debits,
        COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit_cents ELSE 0 END), 0) AS credits
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.entry_id ${cond.length ? 'AND ' + cond.join(' AND ') : ''}
      GROUP BY a.id, a.code, a.name, a.type, a.active ORDER BY a.code`)
    .all(...params);
  return rows.map((r) => ({ ...r, debits: Number(r.debits), credits: Number(r.credits), balance: DEBIT_NORMAL.has(r.type) ? r.debits - r.credits : r.credits - r.debits }));
}

function sumType(rows, type) {
  return rows.filter((r) => r.type === type).reduce((s, r) => s + r.balance, 0);
}

async function profitAndLoss(from, to) {
  const rows = (await balances({ from, to })).filter((r) => ['income', 'cogs', 'expense'].includes(r.type));
  const income = sumType(rows, 'income');
  const cogs = sumType(rows, 'cogs');
  const expense = sumType(rows, 'expense');
  return { from, to, rows, income, cogs, grossProfit: income - cogs, expense, netIncome: income - cogs - expense };
}

async function balanceSheet(asOf) {
  const rows = await balances({ to: asOf });
  const assets = sumType(rows, 'asset');
  const liabilities = sumType(rows, 'liability');
  const equity = sumType(rows, 'equity');
  // Income statement accounts aren't closed into retained earnings by a
  // year-end entry here; their cumulative net is shown as current earnings.
  const earnings = sumType(rows, 'income') - sumType(rows, 'cogs') - sumType(rows, 'expense');
  return { asOf, rows: rows.filter((r) => ['asset', 'liability', 'equity'].includes(r.type)), assets, liabilities, equity, earnings, balanced: assets === liabilities + equity + earnings };
}

async function trialBalance(asOf) {
  const rows = (await balances({ to: asOf })).filter((r) => r.debits || r.credits);
  const out = rows.map((r) => {
    const net = r.debits - r.credits;
    return { ...r, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });
  return { asOf, rows: out, totalDebit: out.reduce((s, r) => s + r.debit, 0), totalCredit: out.reduce((s, r) => s + r.credit, 0) };
}

// Cash-basis summary of the cash account's movements by counter-account.
async function cashFlow(from, to) {
  const cash = await accountByCode('1000');
  const rows = await db
    .prepare(`SELECT a.code, a.name, a.type, SUM(other.credit_cents - other.debit_cents) AS amount
      FROM journal_lines c
      JOIN journal_entries je ON je.id = c.entry_id
      JOIN journal_lines other ON other.entry_id = c.entry_id AND other.account_id <> c.account_id
      JOIN accounts a ON a.id = other.account_id
      WHERE c.account_id = ? AND je.entry_date >= ? AND je.entry_date <= ?
      GROUP BY a.code, a.name, a.type ORDER BY a.code`)
    .all(cash.id, from, to);
  const opening = (await balances({ to: fmt.addDays(from, -1) })).find((r) => r.code === '1000').balance;
  const closing = (await balances({ to })).find((r) => r.code === '1000').balance;
  // Per counter-account amounts sum exactly to the cash account's net
  // movement for each entry (entries are balanced).
  const inflows = rows.filter((r) => r.amount > 0).reduce((s, r) => s + Number(r.amount), 0);
  const outflows = rows.filter((r) => r.amount < 0).reduce((s, r) => s + Number(r.amount), 0);
  return { from, to, rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })), opening, closing, inflows, outflows, net: closing - opening };
}

module.exports = { TYPES, DEBIT_NORMAL, listAccounts, accountByCode, post, reverse, getEntry, listEntries, balances, profitAndLoss, balanceSheet, trialBalance, cashFlow };
