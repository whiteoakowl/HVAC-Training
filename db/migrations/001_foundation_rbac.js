// Foundation for the HVAC business system:
//  - configurable roles + permissions (replaces the hard-coded
//    student < instructor < admin rank; the three original role keys are
//    kept so every existing account keeps working)
//  - members.role loses its CHECK constraint and instead references
//    roles(key), so new roles can be added without another rebuild
//  - login-hardening columns on members
//  - employee profiles, company settings, audit log
// Existing rows are copied, never dropped.

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// [key, label, module]
const PERMISSIONS = [
  ['system.admin', 'Full owner access (bypasses every check)', 'Administration'],
  ['users.manage', 'Add, edit and deactivate user accounts', 'Administration'],
  ['roles.manage', 'Edit role permissions', 'Administration'],
  ['settings.manage', 'Edit company settings', 'Administration'],
  ['audit.view', 'View the audit log', 'Administration'],
  ['employees.view', 'View employee records', 'Employees'],
  ['employees.manage', 'Edit employee records and pay rates', 'Employees'],
  ['portal.employee', 'Employee portal', 'Portals'],
  ['portal.service', 'Customer service portal', 'Portals'],
  ['portal.management', 'Management portal and business dashboard', 'Portals'],
  ['training.view', 'Take assigned training', 'Training'],
  ['training.manage', 'Build courses and assign training', 'Training'],
  ['events.view', 'View and register for events', 'Events'],
  ['events.manage', 'Create and edit events', 'Events'],
  ['documents.view', 'View shared documents', 'Documents'],
  ['documents.manage', 'Upload and delete documents', 'Documents'],
  ['forums.use', 'Use team chat', 'Chat'],
  ['forums.moderate', 'Moderate team chat', 'Chat'],
  ['directory.view', 'View the member directory', 'Directory'],
  ['directory.settings', 'Configure the member directory', 'Directory'],
  ['customers.view', 'View customers, properties and equipment', 'Customers'],
  ['customers.edit', 'Create and edit customers, log communication', 'Customers'],
  ['requests.view', 'View service requests', 'Service Requests'],
  ['requests.manage', 'Create, update and convert service requests', 'Service Requests'],
  ['jobs.view_assigned', 'View jobs assigned to me', 'Jobs'],
  ['jobs.view_all', 'View all jobs', 'Jobs'],
  ['jobs.manage', 'Create, edit and schedule jobs', 'Jobs'],
  ['jobs.dispatch', 'Assign technicians and trucks (dispatch)', 'Jobs'],
  ['jobs.work', 'Work assigned jobs (notes, photos, materials, signatures, complete)', 'Jobs'],
  ['jobs.costing', 'View job costing and profitability', 'Jobs'],
  ['inventory.view', 'View inventory and truck stock', 'Inventory'],
  ['inventory.manage', 'Receive, transfer and adjust inventory', 'Inventory'],
  ['inventory.use', 'Record materials used from my truck', 'Inventory'],
  ['trucks.manage', 'Manage trucks and truck assignments', 'Inventory'],
  ['invoices.view', 'Look up invoices and payments', 'Billing'],
  ['invoices.manage', 'Create, edit, issue and void invoices', 'Billing'],
  ['payments.record', 'Record customer payments', 'Billing'],
  ['accounting.view', 'View ledgers and financial reports', 'Accounting'],
  ['accounting.manage', 'Post manual journal entries, manage chart of accounts', 'Accounting'],
  ['timeclock.use', 'Use the time clock', 'Time'],
  ['timesheets.approve', 'Review and approve timesheets', 'Time'],
];

const STAFF_BASE = ['portal.employee', 'timeclock.use', 'training.view', 'events.view', 'documents.view', 'forums.use', 'directory.view'];
const TECH = [...STAFF_BASE, 'jobs.view_assigned', 'jobs.work', 'inventory.use', 'inventory.view'];
const ALL_BUT_OWNER = PERMISSIONS.map((p) => p[0]).filter((k) => !['system.admin', 'roles.manage'].includes(k));

// [key, name, description, permissions]
const ROLES = [
  ['admin', 'Owner / Super Administrator', 'Full access to everything.', ['system.admin']],
  ['general_manager', 'General Manager', 'Runs day-to-day operations; everything except role editing.', ALL_BUT_OWNER],
  ['office_manager', 'Office Manager', 'Office, billing, scheduling and timesheets.', [
    ...STAFF_BASE, 'portal.service', 'portal.management', 'employees.view', 'customers.view', 'customers.edit', 'requests.view', 'requests.manage',
    'jobs.view_all', 'jobs.manage', 'jobs.dispatch', 'jobs.costing', 'inventory.view', 'invoices.view', 'invoices.manage', 'payments.record', 'timesheets.approve', 'documents.manage', 'events.manage']],
  ['accounting', 'Accounting', 'Billing, payments, ledgers and financial reports.', [
    ...STAFF_BASE, 'portal.management', 'customers.view', 'jobs.view_all', 'jobs.costing', 'inventory.view', 'invoices.view', 'invoices.manage', 'payments.record', 'accounting.view', 'accounting.manage', 'employees.view']],
  ['customer_service', 'Customer Service', 'Customers, service requests, scheduling and invoice lookup. No payroll or company financials.', [
    ...STAFF_BASE, 'portal.service', 'customers.view', 'customers.edit', 'requests.view', 'requests.manage', 'jobs.view_all', 'jobs.manage', 'invoices.view']],
  ['dispatcher', 'Dispatcher', 'Scheduling and dispatching technicians and trucks.', [
    ...STAFF_BASE, 'portal.service', 'customers.view', 'requests.view', 'requests.manage', 'jobs.view_all', 'jobs.manage', 'jobs.dispatch', 'inventory.view']],
  ['service_manager', 'Service Manager', 'Field operations: jobs, technicians, trucks, inventory, training.', [
    ...TECH, 'portal.service', 'portal.management', 'employees.view', 'customers.view', 'customers.edit', 'requests.view', 'requests.manage',
    'jobs.view_all', 'jobs.manage', 'jobs.dispatch', 'jobs.costing', 'inventory.manage', 'trucks.manage', 'timesheets.approve', 'training.manage', 'events.manage', 'documents.manage', 'forums.moderate']],
  ['lead_technician', 'Lead Technician', 'Field technician who can also see customer history.', [...TECH, 'customers.view']],
  ['technician', 'Technician', 'Field technician.', TECH],
  ['installer', 'Installer', 'Installation crew.', TECH],
  ['warehouse_manager', 'Warehouse / Inventory Manager', 'Warehouse, truck stock and transfers.', [...STAFF_BASE, 'inventory.view', 'inventory.manage', 'trucks.manage']],
  ['instructor', 'Training Instructor', 'Original portal role: builds training, events and documents.', [
    'training.view', 'training.manage', 'events.view', 'events.manage', 'documents.view', 'documents.manage', 'forums.use', 'forums.moderate', 'directory.view']],
  ['student', 'Trainee', 'Original portal role: takes training, events, chat and documents.', ['training.view', 'events.view', 'documents.view', 'forums.use', 'directory.view']],
  ['customer', 'Customer', 'Reserved for the customer self-service portal (not yet enabled).', []],
];

function sql() {
  const out = [];
  out.push(`
CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS permissions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  module TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE TABLE IF NOT EXISTS employee_profiles (
  member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  employee_number TEXT UNIQUE,
  job_title TEXT,
  hire_date TEXT,
  pay_type TEXT NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly','salary')),
  pay_rate_cents INTEGER NOT NULL DEFAULT 0,
  address TEXT,
  emergency_contact TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS certifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  number TEXT,
  issued_on TEXT,
  expires_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cert_expires ON certifications (expires_on);
`);
  ROLES.forEach(([key, name, desc], i) => {
    out.push(`INSERT INTO roles (key, name, description, is_system, position) VALUES (${q(key)}, ${q(name)}, ${q(desc)}, 1, ${i}) ON CONFLICT (key) DO NOTHING;`);
  });
  PERMISSIONS.forEach(([key, label, mod]) => {
    out.push(`INSERT INTO permissions (key, label, module) VALUES (${q(key)}, ${q(label)}, ${q(mod)}) ON CONFLICT (key) DO NOTHING;`);
  });
  ROLES.forEach(([key, , , perms]) => {
    [...new Set(perms)].forEach((p) => out.push(`INSERT INTO role_permissions (role_key, permission_key) VALUES (${q(key)}, ${q(p)}) ON CONFLICT DO NOTHING;`));
  });
  const SETTINGS = {
    company_name: 'HVAC Company',
    company_phone: '',
    company_email: '',
    company_address: '',
    default_tax_rate_bp: '0',
    labor_rate_cents: '12500',
    invoice_terms_days: '30',
    invoice_footer: 'Thank you for your business.',
    invoice_payment_instructions: '',
    overtime_weekly_hours: '40',
    allow_registration: '1',
    automation_notify_new_request: '1',
    automation_customer_request_confirmation: '0',
    automation_notify_job_assigned: '1',
    automation_draft_invoice_on_completion: '1',
    automation_low_stock_alerts: '1',
    gps_clock_enabled: '1',
  };
  for (const [k, v] of Object.entries(SETTINGS)) out.push(`INSERT INTO settings (key, value) VALUES (${q(k)}, ${q(v)}) ON CONFLICT (key) DO NOTHING;`);
  return out.join('\n');
}

// SQLite can't drop a CHECK constraint, so members is rebuilt with the
// documented create-copy-drop-rename sequence (foreign keys are off
// while migrations run; ids and every column are copied as-is).
const sqlite = `
CREATE TABLE members_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(key),
  phone TEXT,
  photo_path TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
INSERT INTO members_new (id, name, email, password_hash, role, phone, photo_path, active, created_at)
  SELECT id, name, email, password_hash, role, phone, photo_path, active, created_at FROM members;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
`;

const postgres = `
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_role_check;
ALTER TABLE members ADD COLUMN IF NOT EXISTS last_login_at TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS locked_until TEXT;
ALTER TABLE members ADD CONSTRAINT members_role_fk FOREIGN KEY (role) REFERENCES roles(key);
`;

module.exports = { id: '001_foundation_rbac', sql, sqlite, postgres, ROLES, PERMISSIONS };
