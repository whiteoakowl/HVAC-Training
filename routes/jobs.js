// Jobs, the dispatch board, and job files. Office staff with jobs.manage
// see and edit every job; technicians (jobs.view_assigned + jobs.work)
// only see and work jobs they're assigned to.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requirePermission, forbidden } = require('../middleware/auth');
const db = require('../db');
const jobs = require('../utils/jobs');
const customers = require('../utils/customers');
const inventory = require('../utils/inventory');
const invoices = require('../utils/invoices');
const automation = require('../utils/automation');
const notifications = require('../utils/notifications');
const permissions = require('../utils/permissions');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action, asArray } = require('../utils/http');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 6 } });
const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp|heic|heif)|application\/pdf)$/;

router.use(['/jobs', '/dispatch'], requireAuth);

// Field staff = roles that explicitly hold jobs.work (owners hold every
// permission implicitly but aren't dispatched as technicians).
async function technicians() {
  const people = await db.prepare('SELECT id, name, role FROM members WHERE active = 1 ORDER BY name').all();
  const out = [];
  for (const p of people) if ((await permissions.permissionsForRole(p.role)).has('jobs.work')) out.push(p);
  return out;
}

async function loadJob(req, res, next) {
  const job = await jobs.get(req.params.id);
  if (!job) return res.status(404).render('404', { title: 'Not Found' });
  const assigned = await jobs.isAssigned(job.id, req.member.id);
  req.job = job;
  req.assigned = assigned;
  req.canView = req.can('jobs.view_all') || (assigned && req.can('jobs.view_assigned', 'jobs.work'));
  req.canWork = req.can('jobs.manage') || (assigned && req.can('jobs.work'));
  if (!req.canView) return forbidden(res);
  next();
}

function requireWork(req, res, next) {
  if (!req.canWork) return forbidden(res);
  next();
}

const back = (req) => `/jobs/${req.params.id}`;

// ---------------------------------------------------------------- list
router.get('/jobs', requirePermission('jobs.view_all'), async (req, res) => {
  const status = jobs.STATUS_LABEL[req.query.status] ? req.query.status : null;
  const open = !status && req.query.view !== 'all';
  const rows = await jobs.list({ status, open, q: req.query.q || null, from: fmt.dateOnly(req.query.from), to: req.query.to ? fmt.dateOnly(req.query.to) + ' 23:59:59' : null });
  res.render('jobs-list', { title: 'Jobs', rows, status, open, q: req.query.q || '', from: req.query.from || '', to: req.query.to || '', statuses: jobs.STATUSES });
});

router.get('/jobs/new', requirePermission('jobs.manage'), async (req, res) => {
  const customer = req.query.customer_id ? await customers.get(req.query.customer_id) : null;
  const results = !customer && req.query.q ? await customers.search(req.query.q, { limit: 20 }) : [];
  res.render('jobs-new', { title: 'New Job', customer, results, q: req.query.q || '', properties: customer ? await customers.properties(customer.id) : [], types: jobs.TYPES, statuses: jobs.STATUSES });
});

router.post('/jobs/new', requirePermission('jobs.manage'), action(async (req, res) => {
  const customer = await customers.get(req.body.customer_id);
  if (!customer) throw new Error('Choose a customer.');
  const property = req.body.property_id ? await customers.getProperty(req.body.property_id) : null;
  if (property && property.customer_id !== customer.id) throw new Error('That property belongs to another customer.');
  const id = await jobs.create({
    ...req.body, customer_id: customer.id, property_id: property ? property.id : null,
    estimated_hours: fmt.toNumber(req.body.estimated_hours), quoted_price_cents: fmt.toCents(req.body.quoted_price),
    status: req.body.status || 'ready_to_schedule',
  }, req.member.id);
  await audit.log(req, 'job.create', 'job', id);
  flash(res, `/jobs/${id}`, 'notice', 'Job created.');
}, (req) => `/jobs/new?customer_id=${encodeURIComponent(req.body.customer_id || '')}`));

// ---------------------------------------------------------------- files
router.get('/jobs/files/:fileId', async (req, res) => {
  const f = await db.prepare('SELECT * FROM job_files WHERE id = ?').get(req.params.fileId);
  if (!f) return res.status(404).render('404', { title: 'Not Found' });
  const assigned = await jobs.isAssigned(f.job_id, req.member.id);
  if (!(req.can('jobs.view_all') || req.can('customers.view') || (assigned && req.can('jobs.view_assigned', 'jobs.work')))) return forbidden(res);
  const inline = SAFE_INLINE.test(f.mime_type || '');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', inline ? f.mime_type : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(f.original_name || 'file').replace(/[^\w.\- ]/g, '_')}"`);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(f.content));
});

// ---------------------------------------------------------------- detail
router.get('/jobs/:id', loadJob, async (req, res) => {
  const job = await jobs.details(req.job.id);
  const [properties, equipment, locations, myTruck, techs, trucks, history] = await Promise.all([
    customers.properties(job.customer_id),
    job.property_id ? db.prepare('SELECT * FROM equipment WHERE property_id = ? AND active = 1 ORDER BY id').all(job.property_id) : [],
    req.can('inventory.manage', 'jobs.manage') ? inventory.listLocations() : [],
    db.prepare('SELECT t.*, l.id AS "locationId" FROM trucks t JOIN inventory_locations l ON l.truck_id = t.id WHERE t.assigned_member_id = ? AND t.active = 1').get(req.member.id),
    req.can('jobs.dispatch', 'jobs.manage') ? technicians() : [],
    req.can('jobs.dispatch', 'jobs.manage') ? db.prepare('SELECT t.*, m.name AS "assignedName" FROM trucks t LEFT JOIN members m ON m.id = t.assigned_member_id WHERE t.active = 1 ORDER BY t.name').all() : [],
    job.property_id ? db.prepare("SELECT id, job_number, title, status, completed_at, work_performed FROM jobs WHERE property_id = ? AND id <> ? ORDER BY id DESC LIMIT 10").all(job.property_id, job.id) : [],
  ]);
  // Stock the technician can pull from: their truck, else the job's truck.
  let sourceLocation = myTruck ? { id: myTruck.locationId, name: myTruck.name } : null;
  if (!sourceLocation && job.truck_id) {
    const l = await inventory.truckLocation(job.truck_id);
    if (l) sourceLocation = { id: l.id, name: l.name };
  }
  const stock = sourceLocation ? (await inventory.stockAt(sourceLocation.id)).filter((s) => s.quantity > 0) : [];
  const costing = req.can('jobs.costing') ? await jobs.costing(job.id) : null;
  const assignedIds = job.assignees.map((a) => a.member_id);
  const conflicts = job.scheduled_start && assignedIds.length ? await jobs.conflicts(assignedIds, job.scheduled_start, job.scheduled_end, job.id) : [];
  res.render('jobs-detail', {
    title: `${job.job_number} ${job.title}`, job, properties, equipment, locations, sourceLocation, stock, techs, trucks, costing, history, conflicts,
    canWork: req.canWork, assigned: req.assigned, statuses: jobs.STATUSES, fieldStatuses: jobs.FIELD_STATUSES, types: jobs.TYPES,
    allItems: req.can('inventory.manage', 'jobs.manage') ? await inventory.listItems() : [],
  });
});

router.post('/jobs/:id/edit', requirePermission('jobs.manage'), loadJob, action(async (req, res) => {
  const property = req.body.property_id ? await customers.getProperty(req.body.property_id) : null;
  if (property && property.customer_id !== req.job.customer_id) throw new Error('That property belongs to another customer.');
  await jobs.update(req.job.id, { ...req.body, property_id: property ? property.id : null, estimated_hours: fmt.toNumber(req.body.estimated_hours), quoted_price_cents: fmt.toCents(req.body.quoted_price) });
  await audit.log(req, 'job.update', 'job', req.job.id);
  flash(res, back(req), 'notice', 'Job updated.');
}, back));

router.post('/jobs/:id/status', loadJob, requireWork, action(async (req, res) => {
  const status = req.body.status;
  const office = req.can('jobs.manage');
  if (!office && !jobs.FIELD_STATUSES.includes(status)) throw new Error('Technicians can set Dispatched, In Progress, Waiting on Parts or Inspection Required. Use "Complete job" to finish.');
  if (status === 'completed') throw new Error('Use "Complete job" so the work performed and signature are recorded.');
  if (['invoiced', 'paid'].includes(status)) throw new Error('Invoiced/Paid are set automatically by the invoice.');
  const changed = await jobs.setStatus(req.job.id, status, req.member.id);
  if (changed) {
    await audit.log(req, 'job.status', 'job', req.job.id, { from: req.job.status, to: status });
    if (status === 'waiting_on_parts') {
      await automation.notifyPermission(['jobs.manage'], 'job_status', { title: `${req.job.job_number} waiting on parts`, body: req.job.title, linkUrl: `/jobs/${req.job.id}` }, req.member.id);
    }
  }
  flash(res, back(req), 'notice', `Status: ${jobs.STATUS_LABEL[status]}.`);
}, back));

router.post('/jobs/:id/assign', requirePermission('jobs.dispatch', 'jobs.manage'), loadJob, action(async (req, res) => {
  const start = fmt.fromLocalInput(req.body.scheduled_start);
  const end = fmt.fromLocalInput(req.body.scheduled_end);
  const truckId = req.body.truck_id ? parseInt(req.body.truck_id, 10) : null;
  const memberIds = asArray(req.body.member_ids);
  const { added, conflicts } = await jobs.assign(req.job.id, { memberIds, leadId: req.body.lead_id, truckId, start, end }, req.member.id);
  await audit.log(req, 'job.assign', 'job', req.job.id, { memberIds, truckId, start, end });
  for (const mid of added) {
    await automation.run('automation_notify_job_assigned', 'job', req.job.id, async () => {
      await notifications.notify(mid, 'job_assigned', { title: `New job ${req.job.job_number}`, body: `${req.job.title} · ${start ? fmt.shortDateTime(start) : 'unscheduled'} · ${req.job.address || ''}`, linkUrl: `/jobs/${req.job.id}` });
      return `notified member ${mid}`;
    });
  }
  const msg = conflicts.length
    ? `Saved, but there ${conflicts.length === 1 ? 'is a schedule conflict' : 'are schedule conflicts'}: ${conflicts.map((c) => `${c.memberName} on ${c.job_number} at ${fmt.shortDateTime(c.scheduled_start)}`).join('; ')}`
    : 'Assignment saved.';
  flash(res, back(req), conflicts.length ? 'error' : 'notice', msg);
}, back));

router.post('/jobs/:id/equipment', requirePermission('jobs.manage', 'jobs.work'), loadJob, requireWork, action(async (req, res) => {
  const e = await customers.getEquipment(req.body.equipment_id);
  if (!e || e.customer_id !== req.job.customer_id) throw new Error('Equipment not found for this customer.');
  await db.prepare('INSERT INTO job_equipment (job_id, equipment_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(req.job.id, e.id);
  flash(res, back(req), 'notice', 'Equipment linked to this job.');
}, back));

router.post('/jobs/:id/notes', loadJob, requireWork, action(async (req, res) => {
  await jobs.addNote(req.job.id, req.body.body, req.member.id);
  flash(res, back(req) + '#notes', 'notice', 'Note added.');
}, back));

router.post('/jobs/:id/files', loadJob, requireWork, upload.array('files', 6), action(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw new Error('Choose at least one photo or file.');
  const kind = ['photo', 'receipt', 'document'].includes(req.body.kind) ? req.body.kind : 'photo';
  for (const f of files) {
    await db
      .prepare('INSERT INTO job_files (job_id, member_id, kind, caption, original_name, mime_type, file_size, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.job.id, req.member.id, kind, fmt.clean(req.body.caption, 300), String(f.originalname).slice(0, 200), f.mimetype, f.size, f.buffer);
  }
  await audit.log(req, 'job.files', 'job', req.job.id, { count: files.length, kind });
  flash(res, back(req) + '#files', 'notice', `${files.length} file(s) uploaded.`);
}, back));

router.post('/jobs/:id/materials', loadJob, requireWork, action(async (req, res) => {
  const qty = fmt.toNumber(req.body.quantity);
  const itemId = parseInt(req.body.item_id, 10);
  let locationId = parseInt(req.body.location_id, 10);
  const manager = req.can('inventory.manage', 'jobs.manage');
  if (!manager) {
    if (!req.can('inventory.use')) throw new Error('You do not have permission to record materials.');
    // Technicians pull only from their own truck (or the job's truck).
    const own = await db.prepare('SELECT l.id FROM trucks t JOIN inventory_locations l ON l.truck_id = t.id WHERE t.assigned_member_id = ? AND t.active = 1').get(req.member.id);
    const jobTruck = req.job.truck_id ? await inventory.truckLocation(req.job.truck_id) : null;
    const allowed = [own && own.id, jobTruck && jobTruck.id].filter(Boolean);
    if (!allowed.includes(locationId)) throw new Error('Materials must come from your truck. Submit a parts request if you need something else.');
  }
  if (!locationId) throw new Error('Choose where the material came from.');
  const allowNegative = req.body.allow_negative === '1' && req.can('inventory.manage');
  const result = await db.withTransaction((tx) => inventory.useOnJob(tx, { jobId: req.job.id, itemId, locationId, qty, memberId: req.member.id, allowNegative }));
  await audit.log(req, 'job.material', 'job', req.job.id, { itemId, locationId, qty, allowNegative });
  const low = await db.prepare('SELECT s.quantity, s.min_quantity, i.name, l.name AS "locationName" FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id JOIN inventory_locations l ON l.id = s.location_id WHERE s.item_id = ? AND s.location_id = ?').get(itemId, locationId);
  if (low && low.min_quantity > 0 && low.quantity <= low.min_quantity) {
    await automation.run('automation_low_stock_alerts', 'inventory_item', itemId, async () => {
      const n = await automation.notifyPermission(['inventory.manage'], 'low_stock', { title: `Low stock: ${low.name}`, body: `${low.locationName}: ${low.quantity} left (minimum ${low.min_quantity})`, linkUrl: `/inventory/items/${itemId}` });
      return `notified ${n}`;
    });
  }
  void result;
  flash(res, back(req) + '#materials', 'notice', 'Material recorded and deducted from inventory.');
}, back));

router.post('/jobs/:id/materials/:mid/remove', loadJob, requireWork, action(async (req, res) => {
  const m = await db.prepare('SELECT * FROM job_materials WHERE id = ? AND job_id = ?').get(req.params.mid, req.job.id);
  if (!m) throw new Error('Material line not found.');
  if (!req.can('jobs.manage', 'inventory.manage') && m.member_id !== req.member.id) throw new Error('You can only undo materials you recorded.');
  const invoiced = await db.prepare("SELECT 1 AS x FROM invoices WHERE job_id = ? AND status <> 'draft' AND status <> 'void'").get(req.job.id);
  if (invoiced) throw new Error('This job has been invoiced; materials can no longer be changed.');
  await db.withTransaction((tx) => inventory.returnFromJob(tx, { materialId: m.id, memberId: req.member.id }));
  await audit.log(req, 'job.material_return', 'job', req.job.id, { materialId: m.id });
  flash(res, back(req) + '#materials', 'notice', 'Material removed and returned to stock.');
}, back));

router.post('/jobs/:id/costs', requirePermission('jobs.manage', 'jobs.costing'), loadJob, action(async (req, res) => {
  const amount = fmt.toCents(req.body.amount);
  if (!amount || amount <= 0) throw new Error('Enter an amount.');
  const category = ['equipment', 'subcontractor', 'permit', 'other'].includes(req.body.category) ? req.body.category : 'other';
  const desc = fmt.clean(req.body.description, 300);
  if (!desc) throw new Error('Describe the cost.');
  await db.prepare('INSERT INTO job_costs (job_id, category, description, amount_cents, member_id) VALUES (?, ?, ?, ?, ?)').run(req.job.id, category, desc, amount, req.member.id);
  await audit.log(req, 'job.cost', 'job', req.job.id, { category, amount });
  flash(res, back(req) + '#costing', 'notice', 'Cost added.');
}, back));

router.post('/jobs/:id/complete', loadJob, requireWork, action(async (req, res) => {
  await jobs.complete(req.job.id, { workPerformed: req.body.work_performed, signatureName: req.body.signature_name, signatureData: req.body.signature_data }, req.member.id);
  await audit.log(req, 'job.complete', 'job', req.job.id, { signed: Boolean(req.body.signature_data) });
  await automation.notifyPermission(['jobs.manage'], 'job_completed', { title: `${req.job.job_number} completed`, body: `${req.job.customerName} - ${req.job.title}`, linkUrl: `/jobs/${req.job.id}` }, req.member.id);
  await automation.run('automation_draft_invoice_on_completion', 'job', req.job.id, async () => {
    const { id, created } = await invoices.createFromJob(req.job.id, req.member.id);
    if (created) await automation.notifyPermission(['invoices.manage'], 'invoice_ready', { title: `Draft invoice ready: ${req.job.job_number}`, body: 'Review and issue it.', linkUrl: `/invoices/${id}` });
    return created ? `draft invoice #${id}` : `invoice #${id} already existed`;
  });
  flash(res, back(req), 'notice', 'Job completed. Thank you!');
}, back));

router.post('/jobs/:id/invoice', requirePermission('invoices.manage'), loadJob, action(async (req, res) => {
  const { id, created } = await invoices.createFromJob(req.job.id, req.member.id);
  if (created) await audit.log(req, 'invoice.create', 'invoice', id, { jobId: req.job.id });
  flash(res, `/invoices/${id}`, 'notice', created ? 'Draft invoice created from the job. Review it, then issue.' : 'This job already has an invoice.');
}, back));

// ---------------------------------------------------------------- dispatch
router.get('/dispatch', requirePermission('jobs.dispatch', 'jobs.manage'), async (req, res) => {
  const date = fmt.dateOnly(req.query.date) || fmt.today();
  const techs = await technicians();
  const dayJobs = await jobs.list({ from: date + ' 00:00:00', to: date + ' 23:59:59', limit: 1000 });
  const unscheduled = (await jobs.list({ open: true, limit: 500 })).filter((j) => !j.scheduled_start && !['cancelled', 'new_lead', 'estimate_requested', 'awaiting_approval', 'estimate_sent'].includes(j.status));
  const columns = techs.map((t) => ({ tech: t, jobs: dayJobs.filter((j) => j.techs.some((x) => x.id === t.id)) }));
  for (const col of columns) {
    const sorted = col.jobs.slice().sort((a, b) => (a.scheduled_start < b.scheduled_start ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) if (jobs.endOf(sorted[i - 1]) > sorted[i].scheduled_start) { sorted[i].conflict = true; sorted[i - 1].conflict = true; }
  }
  const unassigned = dayJobs.filter((j) => !j.techs.length);
  res.render('dispatch', { title: 'Dispatch Board', date, columns, unscheduled, unassigned, prev: fmt.addDays(date, -1), next: fmt.addDays(date, 1) });
});

// Drag-and-drop target: move a job onto a technician (and date).
router.post('/dispatch/move', requirePermission('jobs.dispatch', 'jobs.manage'), async (req, res) => {
  try {
    const job = await jobs.get(req.body.job_id);
    if (!job) throw new Error('Job not found.');
    const date = fmt.dateOnly(req.body.date) || fmt.today();
    const toId = parseInt(req.body.member_id, 10);
    const fromId = parseInt(req.body.from_member_id, 10) || null;
    const current = (await db.prepare('SELECT member_id FROM job_assignments WHERE job_id = ?').all(job.id)).map((r) => r.member_id);
    const crew = [...new Set(current.filter((m) => m !== fromId).concat(toId ? [toId] : []))];
    const time = job.scheduled_start ? job.scheduled_start.slice(11) : '08:00:00';
    const start = `${date} ${time}`;
    const durationMin = job.scheduled_end && job.scheduled_start ? fmt.minutesBetween(job.scheduled_start, job.scheduled_end) : null;
    const end = durationMin ? fmt.nowText(new Date(fmt.parseTs(start) + durationMin * 60000)) : null;
    const { added, conflicts } = await jobs.assign(job.id, { memberIds: crew, leadId: toId, truckId: job.truck_id, start, end }, req.member.id);
    await audit.log(req, 'job.dispatch_move', 'job', job.id, { crew, start });
    for (const mid of added) {
      await automation.run('automation_notify_job_assigned', 'job', job.id, async () => {
        await notifications.notify(mid, 'job_assigned', { title: `New job ${job.job_number}`, body: `${job.title} · ${fmt.shortDateTime(start)}`, linkUrl: `/jobs/${job.id}` });
        return `notified member ${mid}`;
      });
    }
    res.json({ ok: true, conflicts: conflicts.map((c) => `${c.memberName}: ${c.job_number} at ${fmt.shortDateTime(c.scheduled_start)}`) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.code ? 'Could not move the job.' : err.message });
  }
});

module.exports = router;
