// QuickBooks-style bookkeeping built into the app (no outside accounting
// software): bank & credit card accounts with registers, bank statement
// import + categorization rules, reconciliation, and closing the books.
module.exports = {
  id: '006_banking_and_books',
  sql: `
ALTER TABLE accounts ADD COLUMN subtype TEXT;
ALTER TABLE accounts ADD COLUMN description TEXT;
ALTER TABLE accounts ADD COLUMN account_last4 TEXT;
UPDATE accounts SET subtype = 'bank' WHERE code = '1000';
UPDATE accounts SET subtype = 'credit_card' WHERE code = '2400';
UPDATE accounts SET subtype = 'accounts_receivable' WHERE code = '1100';
UPDATE accounts SET subtype = 'accounts_payable' WHERE code = '2000';

-- Which reconciliation (if any) cleared each bank/card ledger line.
ALTER TABLE journal_lines ADD COLUMN reconciliation_id INTEGER;

CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  statement_date TEXT NOT NULL,
  statement_balance_cents INTEGER NOT NULL,
  beginning_balance_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','undone')),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  file_name TEXT,
  rows_added INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  import_id INTEGER REFERENCES bank_imports(id) ON DELETE SET NULL,
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','matched','added','excluded')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  matched_line_id INTEGER REFERENCES journal_lines(id),
  decided_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_banktx_account ON bank_transactions (account_id, status);

CREATE TABLE IF NOT EXISTS bank_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_text TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any','money_in','money_out')),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  payee TEXT,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO settings (key, value) VALUES ('books_closed_through', '') ON CONFLICT (key) DO NOTHING;
`,
};
