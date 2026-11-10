// End-to-end business workflow across modules and roles:
// Wix request -> customer + service request -> job -> dispatch ->
// technician clocks in, uses truck stock, completes with signature ->
// draft invoice -> accounting issues it -> payments -> ledger.
const test = require('node:test');
const assert = require('node:assert');
const { start, Client, flashOf, idFrom } = require('./helpers');

let ctx;
let db;
test.before(async () => {
  ctx = await start({ demo: true });
  db = ctx.db;
});
test.after(async () => ctx.stop());

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const today = new Date().toISOString().slice(0, 10);

async function wix(body, secret = 'wix-test-secret') {
  const r = await fetch(ctx.base + '/api/integrations/wix/service-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function balance(code) {
  const accounting = require('../utils/accounting');
  return (await accounting.balances()).find((r) => r.code === code).balance;
}

const state = {};

test('Wix intake: auth, customer dedupe, idempotent retries', async () => {
  assert.strictEqual((await wix({ name: 'X' }, null)).status, 401);
  assert.strictEqual((await wix({ name: 'X' }, 'wrong')).status, 401);
  const before = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
  const r1 = await wix({ name: 'Jordan Fields', email: 'Jordan.Fields@Example.com', phone: '555-444-1212', address: '7 Oak St', city: 'Springfield', state: 'IL', zip: '62701', requestType: 'Request Service', message: 'AC blowing warm air', submissionId: 'abc-1' });
  assert.strictEqual(r1.status, 201);
  assert.match(r1.body.requestNumber, /^SR-\d{6}$/);
  const retry = await wix({ name: 'Jordan Fields', email: 'jordan.fields@example.com', submissionId: 'abc-1' });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.body.duplicate, true);
  assert.strictEqual(retry.body.requestNumber, r1.body.requestNumber);
  // Second, different request from the same person (matched by phone) -> same customer.
  const r2 = await wix({ name: 'J. Fields', phone: '(555) 444-1212', requestType: 'estimate', message: 'Quote for new furnace', submissionId: 'abc-2' });
  assert.strictEqual(r2.status, 201);
  const after = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
  assert.strictEqual(after, before + 1, 'exactly one new customer for two requests');
  const sr = await db.prepare('SELECT * FROM service_requests WHERE request_number = ?').get(r1.body.requestNumber);
  const sr2 = await db.prepare('SELECT * FROM service_requests WHERE request_number = ?').get(r2.body.requestNumber);
  assert.strictEqual(sr.customer_id, sr2.customer_id);
  assert.strictEqual(sr.source, 'wix');
  const props = await db.prepare('SELECT COUNT(*) AS c FROM properties WHERE customer_id = ?').get(sr.customer_id);
  assert.strictEqual(props.c, 1);
  // Customer service was notified; confirmation was skipped (rule off by default).
  const notes = await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type_key = 'service_request'").get();
  assert.ok(notes.c > 0, 'customer service notified');
  const runs = await db.prepare("SELECT result FROM automation_runs WHERE rule_key = 'automation_customer_request_confirmation' AND entity_id = ?").get(sr.id);
  assert.match(runs.result, /skipped/);
  state.sr = sr;
});

test('customer service converts the request; cannot see payroll or financials', async () => {
  const csr = new Client(ctx.base);
  await csr.login('csr@hvacdemo.test');
  const page = await csr.get(`/requests/${state.sr.id}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Jordan Fields/);
  const conv = await csr.post(`/requests/${state.sr.id}/convert`, { title: 'AC not cooling' });
  state.jobId = idFrom(conv.url, '/jobs');
  assert.ok(state.jobId, 'redirected to new job');
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(state.jobId);
  assert.strictEqual(job.status, 'ready_to_schedule');
  assert.strictEqual(job.customer_id, state.sr.customer_id);
  assert.strictEqual((await db.prepare('SELECT status FROM service_requests WHERE id = ?').get(state.sr.id)).status, 'converted');
  for (const url of ['/accounting', '/manage', '/manage/timesheets', '/manage/employees', '/admin/settings', '/portal/members']) {
    assert.strictEqual((await csr.get(url)).status, 403, `CSR must not reach ${url}`);
  }
  // Converting twice is refused.
  const again = await csr.post(`/requests/${state.sr.id}/convert`, {});
  assert.match(flashOf(again), /already has a job/);
});

test('dispatcher schedules the technician and truck; conflicts are flagged', async () => {
  const d = new Client(ctx.base);
  await d.login('dispatch@hvacdemo.test');
  const tech = await db.prepare("SELECT id FROM members WHERE email = 'tech@hvacdemo.test'").get();
  const truck = await db.prepare('SELECT id FROM trucks WHERE assigned_member_id = ?').get(tech.id);
  state.techId = tech.id;
  const r = await d.post(`/jobs/${state.jobId}/assign`, { member_ids: [tech.id], truck_id: truck.id, scheduled_start: `${today}T14:00`, scheduled_end: `${today}T16:00` });
  assert.match(flashOf(r), /Assignment saved/);
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(state.jobId);
  assert.strictEqual(job.status, 'scheduled');
  assert.strictEqual(job.truck_id, truck.id);
  const n = await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE member_id = ? AND type_key = 'job_assigned'").get(tech.id);
  assert.ok(n.c >= 1, 'technician notified');
  // A second overlapping job for the same tech is saved but flagged.
  const other = await db.prepare("SELECT id FROM jobs WHERE title LIKE 'Estimate%'").get();
  const c = await d.post(`/jobs/${other.id}/assign`, { member_ids: [tech.id], scheduled_start: `${today}T15:00`, scheduled_end: `${today}T15:30` });
  assert.match(flashOf(c), /conflict/i);
  await d.post(`/jobs/${other.id}/assign`, { member_ids: [], scheduled_start: '' });
  // Dispatch board renders the job under the tech.
  const board = await d.get(`/dispatch?date=${today}`);
  assert.match(board.text, new RegExp(job.job_number));
});

test('technician works the job from the field', async () => {
  const t = new Client(ctx.base);
  await t.login('tech@hvacdemo.test');
  const mine = await t.get('/employee/jobs');
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(state.jobId);
  assert.match(mine.text, new RegExp(job.job_number));
  // Not assigned to the lead tech's job -> forbidden.
  const leadJob = await db.prepare("SELECT id FROM jobs WHERE title LIKE 'No heat%'").get();
  assert.strictEqual((await t.get(`/jobs/${leadJob.id}`)).status, 403);
  assert.strictEqual((await t.get('/jobs')).status, 403, 'no all-jobs list for technicians');
  assert.strictEqual((await t.get('/invoices')).status, 403);
  assert.strictEqual((await t.get('/accounting')).status, 403);

  const clockIn = await t.post('/employee/time/in', { job_id: state.jobId, lat: '39.78', lng: '-89.65' });
  assert.match(flashOf(clockIn), /Clocked in/);
  assert.match(flashOf(await t.post('/employee/time/in', {})), /already clocked in/);
  await t.post(`/jobs/${state.jobId}/status`, { status: 'in_progress' });
  assert.strictEqual((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(state.jobId)).status, 'in_progress');
  // Technicians can't jump to office-only statuses.
  assert.match(flashOf(await t.post(`/jobs/${state.jobId}/status`, { status: 'cancelled' })), /Technicians can set/);

  const item = await db.prepare("SELECT * FROM inventory_items WHERE sku = 'CAP-4553'").get();
  const loc = await db.prepare('SELECT l.id FROM trucks tr JOIN inventory_locations l ON l.truck_id = tr.id WHERE tr.assigned_member_id = ?').get(state.techId);
  const qty0 = (await db.prepare('SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(item.id, loc.id)).quantity;
  // Too many -> refused, nothing deducted.
  const tooMany = await t.post(`/jobs/${state.jobId}/materials`, { item_id: item.id, location_id: loc.id, quantity: 999 });
  assert.match(flashOf(tooMany), /Not enough/);
  assert.strictEqual((await db.prepare('SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(item.id, loc.id)).quantity, qty0);
  // Can't pull from the warehouse directly.
  const wh = await db.prepare("SELECT id FROM inventory_locations WHERE kind = 'warehouse'").get();
  assert.match(flashOf(await t.post(`/jobs/${state.jobId}/materials`, { item_id: item.id, location_id: wh.id, quantity: 1 })), /must come from your truck/);
  // One capacitor from the truck.
  const inv0 = await balance('1200');
  const cogs0 = await balance('5000');
  const used = await t.post(`/jobs/${state.jobId}/materials`, { item_id: item.id, location_id: loc.id, quantity: 1 });
  assert.match(flashOf(used), /deducted/);
  assert.strictEqual((await db.prepare('SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(item.id, loc.id)).quantity, qty0 - 1);
  assert.strictEqual(await balance('1200'), inv0 - item.unit_cost_cents, 'inventory asset reduced at cost');
  assert.strictEqual(await balance('5000'), cogs0 + item.unit_cost_cents, 'COGS increased at cost');
  state.item = item;

  await t.post(`/jobs/${state.jobId}/notes`, { body: 'Replaced failed run capacitor; system cooling, 18F split.' });
  const fd = new FormData();
  fd.append('kind', 'photo');
  fd.append('caption', 'Old capacitor');
  fd.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'cap.png');
  const up = await fetch(`${ctx.base}/jobs/${state.jobId}/files`, { method: 'POST', body: fd, headers: { cookie: t.cookieHeader() }, redirect: 'manual' });
  assert.strictEqual(up.status, 302);
  const file = await db.prepare('SELECT id FROM job_files WHERE job_id = ?').get(state.jobId);
  const dl = await t.get(`/jobs/files/${file.id}`);
  assert.strictEqual(dl.status, 200);

  // Backdate the time entry 2 hours so labor is measurable, then clock out.
  await db.prepare("UPDATE time_entries SET clock_in = ? WHERE member_id = ? AND status = 'open'").run(new Date(Date.now() - 2 * 3600e3).toISOString().slice(0, 19).replace('T', ' '), state.techId);
  assert.match(flashOf(await t.post('/employee/time/out', { lat: '39.78', lng: '-89.65' })), /Clocked out/);
  const entry = await db.prepare('SELECT * FROM time_entries WHERE member_id = ? ORDER BY id DESC').get(state.techId);
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(entry.job_id, state.jobId);
  assert.ok(entry.in_lat && entry.out_lat, 'GPS stamped at clock events');
  state.entryId = entry.id;

  // Completing requires a description of the work.
  assert.match(flashOf(await t.post(`/jobs/${state.jobId}/complete`, { work_performed: '' })), /Describe the work/);
  const done = await t.post(`/jobs/${state.jobId}/complete`, { work_performed: 'Replaced capacitor, verified operation.', signature_name: 'Jordan Fields', signature_data: SIG });
  assert.match(flashOf(done), /completed/i);
  const job2 = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(state.jobId);
  assert.strictEqual(job2.status, 'completed');
  assert.ok(job2.signature_data && job2.completed_at);
});

test('completion creates a draft invoice; accounting issues it and records payments', async () => {
  const inv = await db.prepare("SELECT * FROM invoices WHERE job_id = ? AND status = 'draft'").get(state.jobId);
  assert.ok(inv, 'draft invoice created automatically');
  const lines = await db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(inv.id);
  assert.ok(lines.some((l) => l.kind === 'labor' && Number(l.quantity) >= 1.9), 'labor from clocked time');
  assert.ok(lines.some((l) => l.kind === 'material' && l.unit_price_cents === state.item.price_cents), 'material at selling price');
  // No ledger impact while draft.
  assert.strictEqual(inv.journal_entry_id, null);

  const a = new Client(ctx.base);
  await a.login('accounting@hvacdemo.test');
  await a.post(`/invoices/${inv.id}/edit`, { discount: '10.00', tax_rate: '7', terms: 'Net 15' });
  const ar0 = await balance('1100');
  const rev0 = (await balance('4000')) + (await balance('4100')) + (await balance('4900'));
  const tax0 = await balance('2100');
  const issued = await a.post(`/invoices/${inv.id}/issue`, { issue_date: today });
  assert.match(flashOf(issued), /issued/);
  const inv2 = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
  assert.strictEqual(inv2.status, 'issued');
  assert.strictEqual(inv2.subtotal_cents - inv2.discount_cents + inv2.tax_cents, inv2.total_cents);
  assert.strictEqual(inv2.due_date, new Date(Date.parse(today) + 15 * 864e5).toISOString().slice(0, 10));
  assert.strictEqual(await balance('1100'), ar0 + inv2.total_cents, 'A/R up by invoice total');
  assert.strictEqual((await balance('4000')) + (await balance('4100')) + (await balance('4900')), rev0 + inv2.subtotal_cents - inv2.discount_cents, 'net revenue recognized');
  assert.strictEqual(await balance('2100'), tax0 + inv2.tax_cents, 'sales tax liability');
  assert.strictEqual((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(state.jobId)).status, 'invoiced');
  // Issued invoices are locked.
  assert.match(flashOf(await a.post(`/invoices/${inv.id}/lines`, { kind: 'fee', description: 'x', quantity: 1, unit_price: '5' })), /Only draft/);

  // Overpayment refused; partial then final payment.
  assert.match(flashOf(await a.post(`/invoices/${inv.id}/payments`, { amount: (inv2.total_cents / 100 + 1).toFixed(2), method: 'check' })), /exceeds/);
  const cash0 = await balance('1000');
  const part = await a.post(`/invoices/${inv.id}/payments`, { amount: '50.00', method: 'check', reference: '1001', received_on: today });
  assert.match(flashOf(part), /Balance due/);
  assert.strictEqual((await db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id)).status, 'partial');
  // Voiding an invoice with payments is refused.
  assert.match(flashOf(await a.post(`/invoices/${inv.id}/void`, { reason: 'test' })), /payments recorded/);
  const rest = ((inv2.total_cents - 5000) / 100).toFixed(2);
  const full = await a.post(`/invoices/${inv.id}/payments`, { amount: rest, method: 'card', received_on: today });
  assert.match(flashOf(full), /paid in full/);
  assert.strictEqual((await db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id)).status, 'paid');
  assert.strictEqual((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(state.jobId)).status, 'paid');
  assert.strictEqual(await balance('1000'), cash0 + inv2.total_cents, 'cash received');
  assert.strictEqual(await balance('1100'), ar0, 'A/R back to where it started');

  // Reports reconcile.
  const accounting = require('../utils/accounting');
  const tb = await accounting.trialBalance(today);
  assert.strictEqual(tb.totalDebit, tb.totalCredit, 'trial balance balances');
  const bs = await accounting.balanceSheet(today);
  assert.ok(bs.balanced, 'balance sheet balances');
  for (const url of ['/accounting/reports/profit-loss', '/accounting/reports/balance-sheet', '/accounting/reports/trial-balance', '/accounting/reports/cash-flow', '/accounting/reports/ar-aging', '/accounting/reports/sales-tax', '/accounting/reports/profit-loss?format=csv', '/manage/reports', '/manage/reports?format=csv']) {
    const r = await a.get(url);
    assert.strictEqual(r.status, 200, url);
  }
  // Job costing sees materials + labor and the invoiced price.
  const jobs = require('../utils/jobs');
  const cost = await jobs.costing(state.jobId);
  assert.strictEqual(cost.materials, state.item.unit_cost_cents);
  assert.ok(cost.labor > 0, 'labor cost from pay rate x hours');
  assert.strictEqual(cost.price, inv2.subtotal_cents - inv2.discount_cents);
});

test('timesheet approval rules', async () => {
  const t = new Client(ctx.base);
  await t.login('tech@hvacdemo.test');
  assert.strictEqual((await t.get('/manage/timesheets')).status, 403, 'employees cannot approve time');
  const om = new Client(ctx.base);
  await om.login('office@hvacdemo.test');
  const r = await om.post('/manage/timesheets/decide', { entry_ids: [state.entryId], decision: 'approved', week: today });
  assert.match(flashOf(r), /1 entry approved/);
  assert.strictEqual((await db.prepare('SELECT status FROM time_entries WHERE id = ?').get(state.entryId)).status, 'approved');
  // Approved time can only change through a reviewed correction.
  const corr = await t.post(`/employee/time/${state.entryId}/correction`, { clock_in: '', clock_out: '', reason: 'Forgot to clock lunch' });
  assert.match(flashOf(corr), /Correction requested/);
  assert.strictEqual((await db.prepare('SELECT status FROM time_entries WHERE id = ?').get(state.entryId)).status, 'approved');
  const csv = await om.get(`/manage/timesheets?week=${today}&format=csv`);
  assert.match(csv.text, /Regular hours/);
});

test('security: privilege escalation, lockout, open redirect, audit trail', async () => {
  const gm = new Client(ctx.base);
  await gm.login('gm@hvacdemo.test');
  const tech = await db.prepare("SELECT id FROM members WHERE email = 'installer@hvacdemo.test'").get();
  const esc = await gm.post(`/portal/members/${tech.id}/role`, { role: 'admin' });
  assert.match(flashOf(esc), /Only an owner/);
  assert.strictEqual((await db.prepare('SELECT role FROM members WHERE id = ?').get(tech.id)).role, 'installer');
  const owner = await db.prepare("SELECT id FROM members WHERE email = 'admin@hvactraining.test'").get();
  const takeover = await gm.post(`/portal/members/${owner.id}/edit`, { name: 'x', email: 'admin@hvactraining.test', password: 'hijacked123' });
  assert.match(flashOf(takeover), /Only an owner/);
  assert.strictEqual((await gm.get('/admin/roles')).status, 403, 'GM cannot edit role permissions');

  const anon = new Client(ctx.base);
  for (let i = 0; i < 5; i++) await anon.post('/login', { email: 'warehouse@hvacdemo.test', password: 'wrong' });
  const locked = await anon.post('/login', { email: 'warehouse@hvacdemo.test', password: 'password123' });
  assert.match(flashOf(locked), /Too many failed attempts/);
  assert.ok(!anon.cookies['hvac.sid']);

  const redir = new Client(ctx.base);
  const r = await redir.request('POST', '/login', { form: { email: 'lead@hvacdemo.test', password: 'password123', next: '//evil.example.com/x' }, follow: false });
  assert.strictEqual(r.location, '/home');
  const r2 = await redir.request('POST', '/login', { form: { email: 'lead@hvacdemo.test', password: 'password123', next: '/\\evil.example.com' }, follow: false });
  assert.strictEqual(r2.location, '/home');

  const actions = (await db.prepare('SELECT DISTINCT action FROM audit_log').all()).map((x) => x.action);
  for (const a of ['auth.login', 'auth.locked', 'service_request.wix', 'service_request.convert', 'job.assign', 'job.material', 'job.complete', 'invoice.issue', 'payment.record', 'timesheet.approved']) {
    assert.ok(actions.includes(a), `audit log has ${a}`);
  }
});

test('original training portal features still work for trainees', async () => {
  const s = new Client(ctx.base);
  const home = await s.login('student@hvactraining.test');
  assert.match(home.url, /\/portal$/);
  for (const url of ['/events', '/training/mine', '/member-directory', '/forums', '/documents', '/notifications']) {
    assert.strictEqual((await s.get(url)).status, 200, url);
  }
  for (const url of ['/customers', '/jobs', '/employee', '/inventory', '/manage', '/training/manage']) {
    assert.strictEqual((await s.get(url)).status, 403, `trainee blocked from ${url}`);
  }
  const reg = new Client(ctx.base);
  const r = await reg.post('/register', { name: 'New Trainee', email: 'new.trainee@example.com', password: 'longenough1' });
  assert.match(r.url, /\/portal$/);
  assert.strictEqual((await db.prepare("SELECT role FROM members WHERE email = 'new.trainee@example.com'").get()).role, 'student');
});
