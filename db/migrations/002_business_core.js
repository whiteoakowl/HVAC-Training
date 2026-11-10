// Core HVAC business data model. All money is stored as integer cents;
// all timestamps are 'YYYY-MM-DD HH:MM:SS' UTC text (same convention as
// the original schema). Human-facing numbers (C-000001, SR-000001,
// J-000001, INV-000001) are unique columns derived from the row id.

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// [code, name, type, normal balance]. type drives the reports.
const ACCOUNTS = [
  ['1000', 'Cash / Operating Checking', 'asset'],
  ['1100', 'Accounts Receivable', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['1500', 'Vehicles & Equipment', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['2100', 'Sales Tax Payable', 'liability'],
  ['2200', 'Customer Deposits', 'liability'],
  ['2300', 'Payroll Liabilities', 'liability'],
  ['3000', "Owner's Equity", 'equity'],
  ['3900', 'Retained Earnings', 'equity'],
  ['4000', 'Service & Labor Revenue', 'income'],
  ['4100', 'Equipment & Materials Sales', 'income'],
  ['4200', 'Maintenance Agreement Revenue', 'income'],
  ['4900', 'Discounts Given', 'income'],
  ['5000', 'Cost of Goods Sold - Materials', 'cogs'],
  ['5100', 'Inventory Shrinkage & Adjustments', 'cogs'],
  ['5200', 'Subcontractor Costs', 'cogs'],
  ['5300', 'Permits', 'cogs'],
  ['6000', 'Payroll Expense', 'expense'],
  ['6100', 'Fuel', 'expense'],
  ['6200', 'Vehicle Expense', 'expense'],
  ['6300', 'Tools & Small Equipment', 'expense'],
  ['6400', 'Office Expense', 'expense'],
  ['6500', 'Insurance', 'expense'],
  ['6600', 'Utilities', 'expense'],
  ['6700', 'Advertising', 'expense'],
  ['6800', 'Repairs & Maintenance', 'expense'],
  ['6900', 'Other Operating Expense', 'expense'],
  ['7000', 'Taxes & Licenses', 'expense'],
];

function sql() {
  const out = [`
-- ------------------------------------------------------------- CRM
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number TEXT UNIQUE,
  account_type TEXT NOT NULL DEFAULT 'residential' CHECK (account_type IN ('residential','commercial')),
  name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  alt_email TEXT,
  phone TEXT,
  phone_digits TEXT,
  alt_phone TEXT,
  billing_address TEXT,
  preferences TEXT,
  notes TEXT,
  source TEXT,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (email);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone_digits);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  access_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_properties_customer ON properties (customer_id);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  equipment_type TEXT NOT NULL,
  manufacturer TEXT,
  model_number TEXT,
  serial_number TEXT,
  install_date TEXT,
  warranty_expires TEXT,
  filter_size TEXT,
  refrigerant_type TEXT,
  location_notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_equipment_property ON equipment (property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_serial ON equipment (serial_number);

CREATE TABLE IF NOT EXISTS customer_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('phone','email','sms','in_person','web','note','complaint','warranty')),
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound','internal')),
  summary TEXT NOT NULL,
  follow_up_on TEXT,
  follow_up_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_interactions_customer ON customer_interactions (customer_id);
CREATE INDEX IF NOT EXISTS idx_interactions_followup ON customer_interactions (follow_up_on, follow_up_done);

-- ------------------------------------------------------------- Service requests
CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_number TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service','estimate','maintenance','emergency','warranty','complaint')),
  description TEXT,
  preferred_date TEXT,
  preferred_time TEXT,
  source TEXT NOT NULL DEFAULT 'office',
  external_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','converted','closed')),
  job_id INTEGER,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON service_requests (status);

-- ------------------------------------------------------------- Fleet + inventory
CREATE TABLE IF NOT EXISTS trucks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  plate TEXT,
  vin TEXT,
  make_model TEXT,
  year INTEGER,
  assigned_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('warehouse','truck')),
  name TEXT NOT NULL,
  truck_id INTEGER UNIQUE REFERENCES trucks(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  manufacturer TEXT,
  supplier TEXT,
  barcode TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  warranty_info TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_stock (
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  quantity REAL NOT NULL DEFAULT 0,
  min_quantity REAL NOT NULL DEFAULT 0,
  bin TEXT,
  PRIMARY KEY (item_id, location_id)
);

-- ------------------------------------------------------------- Jobs
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_number TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  service_request_id INTEGER REFERENCES service_requests(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  job_type TEXT NOT NULL DEFAULT 'service',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','emergency')),
  status TEXT NOT NULL DEFAULT 'new_lead',
  scheduled_start TEXT,
  scheduled_end TEXT,
  estimated_hours REAL,
  truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  quoted_price_cents INTEGER,
  work_performed TEXT,
  completed_at TEXT,
  signature_name TEXT,
  signature_data TEXT,
  signed_at TEXT,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs (customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_sched ON jobs (scheduled_start);

CREATE TABLE IF NOT EXISTS job_assignments (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  is_lead INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, member_id)
);

CREATE TABLE IF NOT EXISTS job_equipment (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS job_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','receipt','document')),
  caption TEXT,
  original_name TEXT,
  mime_type TEXT,
  file_size INTEGER,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('equipment','subcontractor','permit','other')),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id),
  quantity_change REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receive','adjust','transfer_in','transfer_out','job_use','job_return','audit')),
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  related_location_id INTEGER REFERENCES inventory_locations(id),
  note TEXT,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invtx_item ON inventory_transactions (item_id, location_id);
CREATE INDEX IF NOT EXISTS idx_invtx_job ON inventory_transactions (job_id);

CREATE TABLE IF NOT EXISTS job_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id),
  quantity REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  transaction_id INTEGER REFERENCES inventory_transactions(id),
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parts_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  item_id INTEGER REFERENCES inventory_items(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','fulfilled')),
  decided_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- Time clock
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  in_lat REAL, in_lng REAL, out_lat REAL, out_lng REAL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','approved','rejected')),
  approved_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_member ON time_entries (member_id, clock_in);

CREATE TABLE IF NOT EXISTS time_breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS time_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  requested_clock_in TEXT,
  requested_clock_out TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- Accounting
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','cogs','expense')),
  is_system INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  memo TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id INTEGER,
  reverses_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries (source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  CHECK (debit_cents >= 0 AND credit_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines (account_id);

-- ------------------------------------------------------------- Billing
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partial','paid','void')),
  issue_date TEXT,
  due_date TEXT,
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  taxable_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  terms TEXT,
  notes TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices (job_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('labor','material','equipment','fee','other')),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','check','card','ach','other')),
  reference TEXT,
  received_on TEXT NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  recorded_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- Messaging + automation
CREATE TABLE IF NOT EXISTS outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','not_configured')),
  provider TEXT,
  error TEXT,
  related_type TEXT,
  related_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Main warehouse always exists.
INSERT INTO inventory_locations (kind, name) SELECT 'warehouse', 'Main Warehouse' WHERE NOT EXISTS (SELECT 1 FROM inventory_locations WHERE kind = 'warehouse');
`];
  for (const [code, name, type] of ACCOUNTS) {
    out.push(`INSERT INTO accounts (code, name, type, is_system) VALUES (${q(code)}, ${q(name)}, ${q(type)}, 1) ON CONFLICT (code) DO NOTHING;`);
  }
  return out.join('\n');
}

module.exports = { id: '002_business_core', sql, ACCOUNTS };
