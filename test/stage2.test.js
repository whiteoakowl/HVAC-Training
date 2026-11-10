// Stage 2 modules end to end: estimates (customer e-signature -> job ->
// deposit -> final invoice), change orders, credits & refunds,
// purchasing (PO -> approval -> partial receipt -> bill -> payment),
// expenses, maintenance agreements, payroll, time off, messaging,
// customer portal isolation, MFA, documents, training, daily automations.
const test = require('node:test');
const assert = require('node:assert');
const { start, Client, flashOf, idFrom } = require('./helpers');

let ctx;
let db;
let fmt;
let today;
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const state = {};

test.before(async () => {
  ctx = await start({ demo: true });
  db = ctx.db;
  fmt = require('../utils/format');
  await require('../utils/settings').applyTimezone(true);
  today = fmt.today();
});
test.after(async () => ctx.stop());

async function bal(code) {
  return (await require('../utils/accounting').balances()).find((r) => r.code === code).balance;
}
async function login(email) {
  const c = new Client(ctx.base);
  await c.login(email);
  return c;
}

test('estimate: build, send, customer signs via public link, job auto-created', async () => {
  const lead = await login('lead@hvacdemo.test');
  const cust = await db.prepare("SELECT id FROM customers WHERE name = 'Priya Nair'").get();
  const r = await lead.post('/estimates/new', { customer_id: cust.id, title: 'Furnace replacement' });
  const id = idFrom(r.url, '/estimates');
  assert.ok(id);
  const item = await db.prepare("SELECT * FROM inventory_items WHERE sku = 'THM-T6PRO'").get();
  await lead.post(`/estimates/${id}/lines`, { kind: 'equipment', description: '80% 60k BTU furnace', quantity: 1, unit_price: '2400.00', taxable: '1' });
  await lead.post(`/estimates/${id}/lines`, { kind: 'material', item_id: item.id, quantity: 1, unit_price: '', taxable: '1' });
  await lead.post(`/estimates/${id}/lines`, { kind: 'labor', description: 'Install', quantity: 6, unit_price: '125', taxable: '' });
  await lead.post(`/estimates/${id}/edit`, { title: 'Furnace replacement', tax_rate: '7', deposit: '500', discount: '100' });
  const e = await db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  assert.strictEqual(e.subtotal_cents, 240000 + item.price_cents + 75000);
  assert.strictEqual(e.total_cents, e.subtotal_cents - 10000 + e.tax_cents);
  assert.match(flashOf(await lead.post(`/estimates/${id}/send`, { channel: 'email' })), /Marked as sent|sent/);
  const anon = new Client(ctx.base);
  assert.strictEqual((await anon.get(`/e/${'0'.repeat(48)}`)).status, 404);
  const page = await anon.get(`/e/${e.public_token}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Furnace replacement/);
  assert.match(flashOf(await anon.post(`/e/${e.public_token}`, { decision: 'approve', name: 'Priya Nair' })), /confirm you agree/);
  const ok = await anon.post(`/e/${e.public_token}`, { decision: 'approve', name: 'Priya Nair', agree: '1', signature_data: SIG });
  assert.match(flashOf(ok), /Thank you/);
  const e2 = await db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  assert.strictEqual(e2.status, 'converted', 'approval auto-created the job');
  assert.ok(e2.job_id && e2.signature_data);
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(e2.job_id);
  assert.strictEqual(job.status, 'approved');
  assert.strictEqual(job.estimate_id, id);
  // A decided estimate can't be changed or re-approved.
  assert.match(flashOf(await lead.post(`/estimates/${id}/lines`, { kind: 'fee', description: 'x', quantity: 1, unit_price: '1' })), /can't be changed/);
  state.est = e2;
  state.jobId = e2.job_id;
});

test('deposit invoice, change order, final invoice deducts deposit; credit and refund', async () => {
  const acct = await login('accounting@hvacdemo.test');
  const d = await acct.post(`/estimates/${state.est.id}/deposit`, {});
  const depId = idFrom(d.url, '/invoices');
  await acct.post(`/invoices/${depId}/issue`, { issue_date: today });
  const dep = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(depId);
  assert.strictEqual(dep.total_cents, 50000, 'deposit not taxed');
  const liab0 = await bal('2200');
  await acct.post(`/invoices/${depId}/payments`, { amount: '500.00', method: 'check', received_on: today });
  assert.strictEqual(liab0, 50000, 'deposit held as a liability');

  // Office schedules; technician adds a change order the customer signs.
  const office = await login('office@hvacdemo.test');
  const lead = await db.prepare("SELECT id FROM members WHERE email = 'lead@hvacdemo.test'").get();
  await office.post(`/jobs/${state.jobId}/assign`, { member_ids: [lead.id], scheduled_start: `${today}T08:00`, scheduled_end: `${today}T16:00` });
  const t = await login('lead@hvacdemo.test');
  await t.post(`/jobs/${state.jobId}/change-orders`, { description: 'Replace rusted plenum', amount: '350' });
  const co = await db.prepare('SELECT * FROM change_orders WHERE job_id = ?').get(state.jobId);
  assert.match(flashOf(await t.post(`/jobs/${state.jobId}/change-orders/${co.id}`, { decision: 'approve', approved_name: '' })), /customer's name/);
  await t.post(`/jobs/${state.jobId}/change-orders/${co.id}`, { decision: 'approve', approved_name: 'Priya Nair', signature_data: SIG });
  const tpl = await db.prepare("SELECT * FROM checklist_templates WHERE name LIKE 'Installation%'").get();
  const ck = await t.post(`/jobs/${state.jobId}/checklists`, { template_id: tpl.id, item_0: 'pass', item_1: 'pass', note_1: '450 psi', item_2: 'fail' });
  assert.match(flashOf(ck), /FAIL/);
  await t.post(`/jobs/${state.jobId}/complete`, { work_performed: 'Installed furnace per estimate plus new plenum.', signature_name: 'Priya Nair' });

  const inv = await db.prepare("SELECT * FROM invoices WHERE job_id = ? AND estimate_id IS NULL AND status = 'draft'").get(state.jobId);
  assert.ok(inv, 'final draft invoice');
  const lines = await db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(inv.id);
  assert.ok(lines.some((l) => /Change order #1/.test(l.description) && l.amount_cents === 35000));
  const dl = lines.find((l) => l.account_code === '2200');
  assert.strictEqual(dl.amount_cents, -50000, 'deposit deducted');
  assert.strictEqual(inv.discount_cents, 10000, 'estimate discount carried over');
  await acct.post(`/invoices/${inv.id}/issue`, { issue_date: today });
  assert.strictEqual(await bal('2200'), 0, 'deposit liability released by the final invoice');
  const issued = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);

  // Pay in full, then a goodwill credit creates an overpayment that is refunded.
  await acct.post(`/invoices/${inv.id}/payments`, { amount: fmt.centsInput(issued.total_cents), method: 'card', received_on: today });
  assert.strictEqual((await db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id)).status, 'paid');
  const cash0 = await bal('1000');
  await acct.post(`/invoices/${inv.id}/credit`, { amount: '50.00', reason: 'Goodwill - install ran late' });
  await acct.post(`/invoices/${inv.id}/refund`, { amount: '50.00', method: 'card', reason: 'Refund goodwill credit' });
  const after = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
  assert.strictEqual(after.total_cents - after.amount_paid_cents - after.credited_cents, 0);
  assert.strictEqual(after.status, 'paid');
  assert.strictEqual(await bal('1000'), cash0 - 5000, 'refund paid out');
  assert.match(flashOf(await acct.post(`/invoices/${inv.id}/refund`, { amount: '999999', method: 'card', reason: 'x' })), /cannot exceed/);
  // Public invoice link works without login.
  assert.strictEqual((await new Client(ctx.base).get(`/i/${after.public_token}`)).status, 200);
});

test('purchasing: PO approval by another person, partial receipt, bill matched, paid', async () => {
  const wh = await login('warehouse@hvacdemo.test');
  const vendor = await db.prepare('SELECT id FROM vendors LIMIT 1').get();
  const loc = await db.prepare("SELECT id FROM inventory_locations WHERE kind = 'warehouse'").get();
  const item = await db.prepare("SELECT * FROM inventory_items WHERE sku = 'CON-2P30'").get();
  const r = await wh.post('/purchasing/new', { vendor_id: vendor.id, location_id: loc.id });
  const po = idFrom(r.url, '/purchasing');
  await wh.post(`/purchasing/${po}/lines`, { item_id: item.id, quantity: 10, unit_cost: '20.00' });
  await wh.post(`/purchasing/${po}/lines`, { item_id: '', description: 'Shop rags (box)', quantity: 2, unit_cost: '15.00' });
  await wh.post(`/purchasing/${po}/status`, { action: 'submit' });
  assert.match(flashOf(await wh.post(`/purchasing/${po}/status`, { action: 'approve' })), /permission/);
  const acct = await login('accounting@hvacdemo.test');
  await acct.post(`/purchasing/${po}/status`, { action: 'approve' });
  await wh.post(`/purchasing/${po}/status`, { action: 'order' });
  const lines = await db.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY id').all(po);
  const qty0 = (await db.prepare('SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(item.id, loc.id)).quantity;
  const rec = await wh.post(`/purchasing/${po}/receive`, { [`qty_${lines[0].id}`]: 6, [`qty_${lines[1].id}`]: 2 });
  assert.match(flashOf(rec), /backorder/);
  assert.strictEqual((await db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po)).status, 'partial');
  assert.strictEqual((await db.prepare('SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(item.id, loc.id)).quantity, qty0 + 6);
  assert.strictEqual(await bal('2050'), 12000, 'received-not-billed liability for stock');
  assert.match(flashOf(await wh.post(`/purchasing/${po}/receive`, { [`qty_${lines[0].id}`]: 5 })), /Only 4/);
  const ap0 = await bal('2000');
  const b = await acct.post(`/purchasing/${po}/bill`, { bill_number: 'DS-1001', bill_date: today });
  const billId = idFrom(b.url, '/bills');
  const bill = await db.prepare('SELECT * FROM vendor_bills WHERE id = ?').get(billId);
  assert.strictEqual(bill.total_cents, 12000 + 3000);
  assert.strictEqual(await bal('2050'), 0, 'GRNI cleared by the bill');
  assert.strictEqual(await bal('2000'), ap0 + 15000);
  assert.match(flashOf(await acct.post(`/purchasing/${po}/bill`, { bill_number: 'DS-1002' })), /Nothing has been received/);
  await acct.post(`/bills/${billId}/pay`, { amount: '150.00', method: 'check', reference: '2201', paid_on: today });
  assert.strictEqual((await db.prepare('SELECT status FROM vendor_bills WHERE id = ?').get(billId)).status, 'paid');
  assert.strictEqual(await bal('2000'), ap0);
  // Restock drafts respect what is already on order.
  const tech = await login('tech@hvacdemo.test');
  assert.strictEqual((await tech.get('/purchasing')).status, 403);
});

test('expenses and recurring expenses post to the ledger only when a person posts them', async () => {
  const acct = await login('accounting@hvacdemo.test');
  const fuel = await db.prepare("SELECT id FROM accounts WHERE code = '6100'").get();
  const before = await bal('6100');
  await acct.post('/expenses', { expense_date: today, payee: 'Shell', account_id: fuel.id, paid_from: '2400', amount: '84.25', description: 'Truck 1 fuel' });
  assert.strictEqual(await bal('6100'), before + 8425);
  assert.strictEqual(await bal('2400'), 8425, 'charged to the company card');
  const exp = await db.prepare("SELECT id FROM expenses WHERE payee = 'Shell'").get();
  await acct.post(`/expenses/${exp.id}/void`, { reason: 'duplicate' });
  assert.strictEqual(await bal('6100'), before);
  const ins = await db.prepare("SELECT id FROM accounts WHERE code = '6500'").get();
  await acct.post('/expenses/recurring', { payee: 'Acme Insurance', account_id: ins.id, paid_from: '1000', amount: '400', frequency: 'monthly', next_due: today });
  const rec = await db.prepare("SELECT * FROM recurring_expenses WHERE payee = 'Acme Insurance'").get();
  const insBefore = await bal('6500');
  await require('../utils/scheduler').runDaily({ force: true, origin: 'test' });
  assert.strictEqual(await bal('6500'), insBefore, 'daily run never posts expenses');
  await acct.post(`/expenses/recurring/${rec.id}/post`, { amount: '412.10', date: today });
  assert.strictEqual(await bal('6500'), insBefore + 41210);
  assert.ok((await db.prepare('SELECT next_due FROM recurring_expenses WHERE id = ?').get(rec.id)).next_due > today);
});

test('maintenance agreements: visit jobs, covered visit is not billed, agreement invoice to 4200', async () => {
  const csr = await login('csr@hvacdemo.test');
  const ag = await db.prepare('SELECT * FROM maintenance_agreements LIMIT 1').get();
  const visits = await db.prepare('SELECT * FROM agreement_visits WHERE agreement_id = ? ORDER BY visit_number').all(ag.id);
  assert.strictEqual(visits.length, 2);
  // The daily run created a job for the visit already due.
  const due = visits.find((v) => v.job_id);
  assert.ok(due, 'daily automation created a visit job');
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(due.job_id);
  assert.strictEqual(job.job_type, 'maintenance');
  const lead = await db.prepare("SELECT id FROM members WHERE email = 'lead@hvacdemo.test'").get();
  const office = await login('office@hvacdemo.test');
  await office.post(`/jobs/${job.id}/assign`, { member_ids: [lead.id], scheduled_start: `${today}T17:00` });
  const t = await login('lead@hvacdemo.test');
  await t.post(`/jobs/${job.id}/complete`, { work_performed: 'Fall tune-up done.' });
  assert.strictEqual((await db.prepare('SELECT status FROM agreement_visits WHERE id = ?').get(due.id)).status, 'completed');
  assert.ok(!(await db.prepare("SELECT id FROM invoices WHERE job_id = ? AND status <> 'void'").get(job.id)), 'covered visit not invoiced');
  const acct = await login('accounting@hvacdemo.test');
  const r = await acct.post(`/agreements/${ag.id}/invoice`, {});
  assert.strictEqual((await acct.get(r.url)).status, 200);
  const rev0 = await bal('4200');
  const invId = idFrom(r.url, '/invoices');
  await acct.post(`/invoices/${invId}/issue`, { issue_date: today });
  assert.strictEqual(await bal('4200'), rev0 + 18900);
  void csr;
});

test('payroll: prepared from approved time, two-person approval, posted, stubs private', async () => {
  // Approved time for the technician.
  const tech = await db.prepare("SELECT id FROM members WHERE email = 'tech@hvacdemo.test'").get();
  const ws = fmt.weekStart(today);
  for (let d = 0; d < 5; d++) {
    await db.prepare("INSERT INTO time_entries (member_id, clock_in, clock_out, status) VALUES (?, ?, ?, 'approved')").run(tech.id, `${fmt.addDays(ws, d - 7)} 07:00:00`, `${fmt.addDays(ws, d - 7)} 16:30:00`);
  }
  await db.prepare("INSERT INTO time_off_requests (member_id, kind, start_date, end_date, hours, status) VALUES (?, 'vacation', ?, ?, 8, 'approved')").run(tech.id, fmt.addDays(ws, -2), fmt.addDays(ws, -2));
  const acct = await login('accounting@hvacdemo.test');
  const r = await acct.post('/payroll', { period_start: fmt.addDays(ws, -7), period_end: fmt.addDays(ws, -1), pay_date: today });
  const runId = idFrom(r.url, '/payroll');
  assert.ok(runId, flashOf(r));
  const item = await db.prepare('SELECT * FROM payroll_items WHERE run_id = ? AND member_id = ?').get(runId, tech.id);
  assert.strictEqual(item.regular_minutes, 40 * 60);
  assert.strictEqual(item.overtime_minutes, 7.5 * 60);
  assert.strictEqual(item.regular_pay_cents, 40 * 3200);
  assert.strictEqual(item.overtime_pay_cents, Math.round(7.5 * 3200 * 1.5));
  assert.strictEqual(item.pto_pay_cents, 8 * 3200);
  await acct.post(`/payroll/${runId}/items/${item.id}`, { bonus: '100', withholding: '300', deduction: '50', reimbursement: '25' });
  assert.match(flashOf(await acct.post(`/payroll/${runId}/approve`, {})), /other than the preparer/);
  const gm = await login('gm@hvacdemo.test');
  await gm.post(`/payroll/${runId}/approve`, {});
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
  const exp0 = await bal('6000');
  await gm.post(`/payroll/${runId}/post`, {});
  assert.strictEqual(await bal('6000'), exp0 + run.gross_cents);
  const t = await login('tech@hvacdemo.test');
  assert.strictEqual((await t.get('/payroll')).status, 403, 'technicians cannot see payroll');
  const stubs = await t.get('/employee/pay');
  assert.match(stubs.text, new RegExp(fmt.money(item.gross_cents + 10000).replace('$', '\\$')));
  const other = await db.prepare('SELECT id FROM payroll_items WHERE run_id = ? AND member_id <> ?').get(runId, tech.id);
  if (other) assert.strictEqual((await t.get(`/employee/pay/${other.id}`)).status, 404, "can't open someone else's stub");
  const csr = await login('csr@hvacdemo.test');
  assert.strictEqual((await csr.get('/payroll')).status, 403);
});

test('time off, messaging, announcements', async () => {
  const t = await login('tech@hvacdemo.test');
  const r = await t.post('/employee/time-off', { kind: 'vacation', start_date: fmt.addDays(today, 20), end_date: fmt.addDays(today, 21) });
  assert.match(flashOf(r), /Request sent/);
  assert.match(flashOf(await t.post('/employee/time-off', { kind: 'vacation', start_date: fmt.addDays(today, 21) })), /already have a request/);
  const req = await db.prepare("SELECT * FROM time_off_requests WHERE status = 'pending'").get();
  assert.strictEqual(Number(req.hours), 16);
  const sm = await login('servicemgr@hvacdemo.test');
  await sm.post(`/manage/time-off/${req.id}`, { decision: 'approve' });
  const tech = await db.prepare("SELECT id FROM members WHERE email = 'tech@hvacdemo.test'").get();
  assert.strictEqual(Number((await db.prepare('SELECT pto_balance_hours FROM employee_profiles WHERE member_id = ?').get(tech.id)).pto_balance_hours), -16);
  const lead = await db.prepare("SELECT id FROM members WHERE email = 'lead@hvacdemo.test'").get();
  await t.post(`/messages/${lead.id}`, { body: 'Can you bring the vacuum pump?' });
  const l = await login('lead@hvacdemo.test');
  const thread = await l.get(`/messages/${tech.id}`);
  assert.match(thread.text, /vacuum pump/);
  const student = await db.prepare("SELECT id FROM members WHERE email = 'student@hvactraining.test'").get();
  assert.match(flashOf(await t.post(`/messages/${student.id}`, { body: 'hi' })), /cannot receive/);
  await sm.post('/announcements', { title: 'Safety stand-down Friday', body: 'Ladder safety at 7am.' });
  assert.match((await t.get('/employee')).text, /Safety stand-down Friday/);
  const st = await login('student@hvactraining.test');
  assert.strictEqual((await st.get('/announcements')).status, 403);
});

test('customer portal shows only the customer own records', async () => {
  const c = await login('customer@hvacdemo.test');
  const home = await c.get('/home');
  assert.match(home.url, /\/my$/);
  assert.match(home.text, /Dana Whitfield|Welcome, Dana/);
  assert.doesNotMatch(home.text, /Priya Nair|Romero/);
  for (const url of ['/customers', '/jobs', '/invoices', '/employee', '/manage', '/estimates', '/messages', '/announcements', '/portal/members']) {
    assert.strictEqual((await c.get(url)).status, 403, `customer blocked from ${url}`);
  }
  const otherJob = await db.prepare("SELECT j.id FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE c.name <> 'Dana Whitfield' LIMIT 1").get();
  assert.strictEqual((await c.get(`/jobs/${otherJob.id}`)).status, 403);
  const r = await c.post('/my/request', { kind: 'service', description: 'Thermostat blank', property_id: '' });
  assert.match(flashOf(r), /received/);
  const sr = await db.prepare("SELECT * FROM service_requests WHERE source = 'portal'").get();
  assert.strictEqual(sr.customer_id, (await db.prepare("SELECT id FROM customers WHERE name = 'Dana Whitfield'").get()).id);
});

test('documents attached to records follow record permissions', async () => {
  const csr = await login('csr@hvacdemo.test');
  const cust = await db.prepare("SELECT id FROM customers WHERE name = 'Dana Whitfield'").get();
  const fd = new FormData();
  fd.append('title', 'Signed service contract');
  fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'contract.pdf');
  const up = await fetch(`${ctx.base}/files/customer/${cust.id}`, { method: 'POST', body: fd, headers: { cookie: csr.cookieHeader() }, redirect: 'manual' });
  assert.strictEqual(up.status, 302);
  const doc = await db.prepare('SELECT id FROM documents WHERE customer_id = ?').get(cust.id);
  assert.strictEqual((await csr.get(`/files/${doc.id}`)).status, 200);
  const st = await login('student@hvactraining.test');
  assert.strictEqual((await st.get(`/files/${doc.id}`)).status, 403);
  assert.doesNotMatch((await st.get('/documents')).text, /Signed service contract/, 'not in the shared library');
  const admin = await login('admin@hvactraining.test');
  assert.strictEqual((await admin.get(`/documents/${doc.id}/download`)).status, 200, 'redirects to the record file');
});

test('two-step verification and temporary passwords', async () => {
  const mfa = require('../utils/mfa');
  const c = await login('dispatch@hvacdemo.test');
  await c.post('/account/mfa/start', {});
  const secret = JSON.parse(Buffer.from(c.cookies['hvac.sid'], 'base64').toString()).mfaSetup;
  assert.match(flashOf(await c.post('/account/mfa/confirm', { code: '000000' })), /did not match/);
  await c.post('/account/mfa/confirm', { code: mfa.totp(secret) });
  const fresh = new Client(ctx.base);
  const r = await fresh.post('/login', { email: 'dispatch@hvacdemo.test', password: 'password123' });
  assert.match(r.url, /\/login\/mfa/);
  assert.strictEqual((await fresh.get('/service')).status, 200, 'session exists...');
  assert.match((await fresh.get('/service')).url, /\/login/, '...but is not signed in until the code is entered');
  assert.match(flashOf(await fresh.post('/login/mfa', { code: '123456' })), /not right/);
  const ok = await fresh.post('/login/mfa', { code: mfa.totp(secret) });
  assert.match(ok.url, /\/service$/);

  const gm = await login('gm@hvacdemo.test');
  await gm.post('/portal/members/new', { name: 'New Tech', email: 'newtech@hvacdemo.test', role: 'technician', password: 'TempPass123' });
  const n = new Client(ctx.base);
  const first = await n.login('newtech@hvacdemo.test', 'TempPass123');
  assert.match(first.url, /\/account/);
  assert.match((await n.get('/employee')).url, /\/account/, 'forced to change password first');
  await n.post('/account/password', { current: 'TempPass123', password: 'MyOwnPassword9', confirm: 'MyOwnPassword9' });
  assert.match((await n.get('/employee')).url, /\/employee$/);
});

test('training center assigns required courses by role', async () => {
  const sm = await login('servicemgr@hvacdemo.test');
  const tr = await db.prepare("SELECT id FROM trainings WHERE status = 'published' LIMIT 1").get();
  const r = await sm.post('/training/center/required', { role_key: 'technician', training_id: tr.id, due_days: 14, action: 'add' });
  assert.match(flashOf(r), /new assignment/);
  const tech = await db.prepare("SELECT id FROM members WHERE email = 'tech@hvacdemo.test'").get();
  assert.ok(await db.prepare('SELECT id FROM training_assignments WHERE training_id = ? AND member_id = ?').get(tr.id, tech.id));
  assert.strictEqual((await sm.get('/training/center')).status, 200);
});

test('books still balance after every stage-2 posting', async () => {
  const accounting = require('../utils/accounting');
  const tb = await accounting.trialBalance(fmt.addDays(today, 60));
  assert.strictEqual(tb.totalDebit, tb.totalCredit);
  assert.ok((await accounting.balanceSheet(fmt.addDays(today, 60))).balanced);
  const runs = await db.prepare("SELECT COUNT(*) AS c FROM automation_runs WHERE rule_key = 'daily_run'").get();
  assert.ok(runs.c >= 1);
});

test('every date reads MM/DD/YYYY and every time is 12-hour Eastern after a full day of activity', async () => {
  assert.strictEqual(require('../utils/format').timezone(), 'America/New_York');
  const admin = await login('admin@hvactraining.test');
  const ids = async (sql) => (await db.prepare(sql).all()).map((r) => r.id);
  const pages = ['/manage', '/estimates?all=1', '/invoices', '/bills?status=paid', '/purchasing?all=1', '/expenses', '/payroll', '/agreements', '/manage/timesheets', '/manage/time-off',
    '/accounting/journal?from=2000-01-01', '/accounting/reports/ar-aging', '/admin/audit', '/messages', '/announcements', '/training/center', '/inventory/transactions'];
  for (const id of await ids('SELECT id FROM invoices')) pages.push(`/invoices/${id}`);
  for (const id of await ids('SELECT id FROM estimates')) pages.push(`/estimates/${id}`);
  for (const id of await ids('SELECT id FROM jobs')) pages.push(`/jobs/${id}`);
  for (const id of await ids('SELECT id FROM payroll_runs')) pages.push(`/payroll/${id}`);
  for (const id of await ids('SELECT id FROM purchase_orders')) pages.push(`/purchasing/${id}`);
  for (const id of await ids('SELECT id FROM vendor_bills')) pages.push(`/bills/${id}`);
  for (const id of await ids('SELECT id FROM maintenance_agreements')) pages.push(`/agreements/${id}`);
  for (const id of await ids('SELECT id FROM customers')) pages.push(`/customers/${id}`);
  const bad = [];
  for (const url of pages) {
    const r = await admin.get(url);
    assert.strictEqual(r.status, 200, url);
    const text = r.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<textarea[\s\S]*?<\/textarea>/gi, ' ').replace(/<[^>]*>/g, ' ');
    const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
    const h24 = text.match(/\b(1[3-9]|2[0-3]):[0-5]\d\b/);
    if (iso) bad.push(`${url}: ${iso[0]}`);
    if (h24) bad.push(`${url}: ${h24[0]}`);
  }
  assert.deepStrictEqual(bad, []);
  const stub = await db.prepare("SELECT i.id FROM payroll_items i JOIN members m ON m.id = i.member_id WHERE m.email = 'tech@hvacdemo.test'").get();
  const t = await login('tech@hvacdemo.test');
  assert.match((await t.get(`/employee/pay/${stub.id}`)).text, /\d{2}\/\d{2}\/\d{4}/);
  assert.match((await t.get('/employee/time')).text, /Eastern Time \(New York\)/);
});
