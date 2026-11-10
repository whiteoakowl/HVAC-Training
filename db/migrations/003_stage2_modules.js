// Stage 2/3 modules: estimates & change orders, vendors / purchasing /
// vendor bills (A/P), expenses (+ recurring), credits & refunds,
// maintenance agreements, payroll runs, time off, announcements, direct
// messages, end-of-day reports, job checklists, tools & assets,
// password resets, MFA, training categories/renewals/required-by-role,
// documents linked to records, customer portal accounts.
// Additive only: new tables, new nullable/defaulted columns, new rows.

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const PERMISSIONS = [
  ['estimates.view', 'View estimates and proposals', 'Estimates'],
  ['estimates.manage', 'Create, send and revise estimates; record change orders', 'Estimates'],
  ['purchasing.manage', 'Vendors, supply lists and purchase orders; receive deliveries', 'Purchasing'],
  ['purchasing.approve', 'Approve purchase orders and supply requests', 'Purchasing'],
  ['bills.manage', 'Vendor bills and bill payments (accounts payable)', 'Accounting'],
  ['expenses.manage', 'Record expenses and recurring expenses', 'Accounting'],
  ['agreements.manage', 'Maintenance plans and agreements', 'Maintenance Agreements'],
  ['payroll.view', 'View payroll runs and pay rates', 'Payroll'],
  ['payroll.manage', 'Prepare, approve and post payroll runs', 'Payroll'],
  ['timeoff.approve', 'Approve PTO / sick leave requests', 'Time'],
  ['announcements.manage', 'Post company announcements', 'Communication'],
  ['messages.use', 'Send and receive employee messages', 'Communication'],
  ['dailyreports.view', "Read employees' end-of-day reports", 'Employees'],
  ['checklists.manage', 'Build service checklists and inspection forms', 'Jobs'],
  ['assets.manage', 'Tools and equipment assigned to employees and trucks', 'Inventory'],
  ['portal.customer', 'Customer self-service portal (own records only)', 'Portals'],
];

const GRANTS = {
  general_manager: PERMISSIONS.map((p) => p[0]).filter((k) => k !== 'portal.customer'),
  office_manager: ['estimates.view', 'estimates.manage', 'purchasing.manage', 'bills.manage', 'expenses.manage', 'agreements.manage', 'timeoff.approve', 'announcements.manage', 'messages.use', 'dailyreports.view', 'checklists.manage'],
  accounting: ['estimates.view', 'purchasing.approve', 'bills.manage', 'expenses.manage', 'payroll.view', 'payroll.manage', 'messages.use'],
  customer_service: ['estimates.view', 'estimates.manage', 'agreements.manage', 'messages.use'],
  dispatcher: ['estimates.view', 'messages.use'],
  service_manager: ['estimates.view', 'estimates.manage', 'purchasing.manage', 'agreements.manage', 'timeoff.approve', 'announcements.manage', 'messages.use', 'dailyreports.view', 'checklists.manage', 'assets.manage'],
  lead_technician: ['estimates.view', 'estimates.manage', 'messages.use'],
  technician: ['messages.use'],
  installer: ['messages.use'],
  warehouse_manager: ['purchasing.manage', 'assets.manage', 'messages.use'],
  customer: ['portal.customer'],
};

const ACCOUNTS = [
  ['2050', 'Goods Received Not Invoiced', 'liability'],
  ['2400', 'Credit Card Payable', 'liability'],
  ['4910', 'Customer Credits', 'income'],
  ['6010', 'Payroll Taxes (employer)', 'expense'],
  ['6050', 'Employee Reimbursements', 'expense'],
];

const CHECKLISTS = [
  ['AC Tune-Up', 'Replace/inspect filter\nCheck thermostat operation\nInspect & clean condenser coil\nCheck refrigerant pressures (record readings in notes)\nMeasure superheat / subcooling\nCheck capacitor (record MFD)\nCheck contactor\nTighten electrical connections\nMeasure amp draw - compressor\nMeasure amp draw - condenser fan\nClear condensate drain\nMeasure supply/return temperature split'],
  ['Furnace Tune-Up / Safety Inspection', 'Replace/inspect filter\nInspect heat exchanger for cracks\nCheck flue / venting\nTest CO at supply and ambient (record ppm)\nCheck gas pressure\nInspect & clean flame sensor\nCheck igniter\nTest limit and rollout switches\nCheck blower motor and wheel\nVerify thermostat cycling\nCheck condensate (high-efficiency units)'],
  ['Installation Completion', 'Equipment set level and secured\nLine set pressure tested (record psi)\nEvacuated to < 500 microns\nRefrigerant charge verified\nElectrical disconnect and whip installed\nCondensate drain and safety switch tested\nThermostat programmed\nCustomer walkthrough completed\nOld equipment removed\nWarranty registration info recorded'],
];

function sql() {
  const out = [`
-- ------------------------------------------------------------- estimates
CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_number TEXT UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1,
  parent_estimate_id INTEGER REFERENCES estimates(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  service_request_id INTEGER REFERENCES service_requests(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','rejected','expired','superseded','converted')),
  expires_on TEXT,
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  taxable_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  payment_schedule TEXT,
  terms TEXT,
  warranty TEXT,
  public_token TEXT UNIQUE,
  sent_at TEXT,
  decided_at TEXT,
  approved_name TEXT,
  signature_data TEXT,
  rejection_reason TEXT,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_estimates_customer ON estimates (customer_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates (status);

CREATE TABLE IF NOT EXISTS estimate_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('equipment','material','labor','permit','fee','other')),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 1,
  item_id INTEGER REFERENCES inventory_items(id),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_name TEXT,
  signature_data TEXT,
  decided_at TEXT,
  invoiced INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, number)
);

-- ------------------------------------------------------------- vendors / purchasing / A/P
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  account_number TEXT,
  terms_days INTEGER NOT NULL DEFAULT 30,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','ordered','partial','received','cancelled')),
  expected_on TEXT,
  notes TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  approved_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  approved_at TEXT,
  ordered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES inventory_items(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  received_qty REAL NOT NULL DEFAULT 0,
  billed_qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS po_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  quantity REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendor_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  bill_number TEXT,
  bill_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','void')),
  total_cents INTEGER NOT NULL,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  attachment BLOB,
  attachment_name TEXT,
  attachment_mime TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON vendor_bills (vendor_id);

CREATE TABLE IF NOT EXISTS vendor_bill_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  description TEXT,
  amount_cents INTEGER NOT NULL,
  po_line_id INTEGER REFERENCES purchase_order_lines(id),
  quantity REAL
);

CREATE TABLE IF NOT EXISTS bill_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES vendor_bills(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL,
  reference TEXT,
  paid_on TEXT NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  recorded_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- expenses
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payee TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  paid_from_code TEXT NOT NULL DEFAULT '1000',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','annual')),
  next_due TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date TEXT NOT NULL,
  payee TEXT NOT NULL,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  paid_from_code TEXT NOT NULL DEFAULT '1000',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  recurring_expense_id INTEGER REFERENCES recurring_expenses(id) ON DELETE SET NULL,
  receipt BLOB,
  receipt_name TEXT,
  receipt_mime TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date);

-- ------------------------------------------------------------- credits & refunds
ALTER TABLE invoices ADD COLUMN credited_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN public_token TEXT;
ALTER TABLE invoices ADD COLUMN agreement_id INTEGER;
ALTER TABLE invoices ADD COLUMN estimate_id INTEGER;
ALTER TABLE invoice_lines ADD COLUMN account_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_token ON invoices (public_token);

CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL,
  reference TEXT,
  reason TEXT NOT NULL,
  refunded_on TEXT NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- maintenance agreements
CREATE TABLE IF NOT EXISTS maintenance_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  included_services TEXT,
  visits_per_year INTEGER NOT NULL DEFAULT 2,
  price_cents INTEGER NOT NULL DEFAULT 0,
  term_months INTEGER NOT NULL DEFAULT 12,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS maintenance_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_number TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
  plan_id INTEGER REFERENCES maintenance_plans(id),
  name TEXT NOT NULL,
  included_services TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  visits_per_year INTEGER NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled','renewed')),
  renewed_from_id INTEGER REFERENCES maintenance_agreements(id),
  notes TEXT,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agreements_customer ON maintenance_agreements (customer_id);

CREATE TABLE IF NOT EXISTS agreement_equipment (
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  PRIMARY KEY (agreement_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS agreement_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES maintenance_agreements(id) ON DELETE CASCADE,
  visit_number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','scheduled','completed','skipped')),
  UNIQUE (agreement_id, visit_number)
);
ALTER TABLE jobs ADD COLUMN agreement_visit_id INTEGER;
ALTER TABLE jobs ADD COLUMN estimate_id INTEGER;

-- ------------------------------------------------------------- payroll
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','posted','void')),
  gross_cents INTEGER NOT NULL DEFAULT 0,
  withholding_cents INTEGER NOT NULL DEFAULT 0,
  deduction_cents INTEGER NOT NULL DEFAULT 0,
  reimbursement_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  approved_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  approved_at TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  pay_type TEXT NOT NULL,
  rate_cents INTEGER NOT NULL DEFAULT 0,
  regular_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  pto_hours REAL NOT NULL DEFAULT 0,
  regular_pay_cents INTEGER NOT NULL DEFAULT 0,
  overtime_pay_cents INTEGER NOT NULL DEFAULT 0,
  pto_pay_cents INTEGER NOT NULL DEFAULT 0,
  salary_pay_cents INTEGER NOT NULL DEFAULT 0,
  bonus_cents INTEGER NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  reimbursement_cents INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  withholding_cents INTEGER NOT NULL DEFAULT 0,
  deduction_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (run_id, member_id)
);

-- ------------------------------------------------------------- time off
ALTER TABLE employee_profiles ADD COLUMN pto_balance_hours REAL NOT NULL DEFAULT 0;
ALTER TABLE employee_profiles ADD COLUMN sick_balance_hours REAL NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS time_off_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('vacation','sick','personal','unpaid')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  hours REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
  decided_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- communication
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience_role TEXT REFERENCES roles(key),
  pinned INTEGER NOT NULL DEFAULT 0,
  expires_on TEXT,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES members(id),
  to_id INTEGER NOT NULL REFERENCES members(id),
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages (to_id, read_at);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages (from_id, to_id);

CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  report_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  issues TEXT,
  materials_needed TEXT,
  mileage REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (member_id, report_date)
);

-- ------------------------------------------------------------- checklists
CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  items TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS job_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES checklist_templates(id),
  name TEXT NOT NULL,
  results TEXT NOT NULL,
  notes TEXT,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- tools & assets
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  serial_number TEXT,
  assigned_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'in_service' CHECK (status IN ('in_service','repair','lost','retired')),
  purchase_date TEXT,
  cost_cents INTEGER,
  next_service_on TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- auth hardening
ALTER TABLE members ADD COLUMN mfa_secret TEXT;
ALTER TABLE members ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- training + documents
ALTER TABLE trainings ADD COLUMN category TEXT;
ALTER TABLE trainings ADD COLUMN renew_months INTEGER;
CREATE TABLE IF NOT EXISTS required_trainings (
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  due_days INTEGER NOT NULL DEFAULT 30,
  PRIMARY KEY (role_key, training_id)
);

ALTER TABLE documents ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN member_id INTEGER REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN doc_type TEXT;

ALTER TABLE inventory_items ADD COLUMN preferred_vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;
`];
  PERMISSIONS.forEach(([key, label, mod]) => out.push(`INSERT INTO permissions (key, label, module) VALUES (${q(key)}, ${q(label)}, ${q(mod)}) ON CONFLICT (key) DO NOTHING;`));
  for (const [role, perms] of Object.entries(GRANTS)) {
    perms.forEach((p) => out.push(`INSERT INTO role_permissions (role_key, permission_key) SELECT ${q(role)}, ${q(p)} WHERE EXISTS (SELECT 1 FROM roles WHERE key = ${q(role)}) ON CONFLICT DO NOTHING;`));
  }
  ACCOUNTS.forEach(([code, name, type]) => out.push(`INSERT INTO accounts (code, name, type, is_system) VALUES (${q(code)}, ${q(name)}, ${q(type)}, 1) ON CONFLICT (code) DO NOTHING;`));
  CHECKLISTS.forEach(([name, items]) => out.push(`INSERT INTO checklist_templates (name, items) VALUES (${q(name)}, ${q(items)}) ON CONFLICT (name) DO NOTHING;`));
  const SETTINGS = {
    company_timezone: 'America/New_York',
    estimate_valid_days: '30',
    estimate_terms: 'Prices valid until the expiration date. A deposit may be required before equipment is ordered. Balance due on completion.',
    estimate_warranty: "Manufacturer's parts warranty per equipment registration; 1-year labor warranty on installation workmanship.",
    automation_estimate_followups: '1',
    automation_job_from_approved_estimate: '1',
    automation_maintenance_jobs: '1',
    automation_overdue_invoice_alerts: '1',
    automation_customer_payment_reminders: '0',
    automation_certification_alerts: '1',
    automation_training_alerts: '1',
    automation_recurring_expense_alerts: '1',
    maintenance_job_lead_days: '30',
    pto_hours_per_day: '8',
  };
  for (const [k, v] of Object.entries(SETTINGS)) out.push(`INSERT INTO settings (key, value) VALUES (${q(k)}, ${q(v)}) ON CONFLICT (key) DO NOTHING;`);
  return out.join('\n');
}

module.exports = { id: '003_stage2_modules', sql, PERMISSIONS, GRANTS };
