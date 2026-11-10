// Jobs: the work order at the center of the system. A job ties together
// the customer + property, assigned technicians and truck, schedule,
// notes/photos/signature, materials (deducted from truck stock), labor
// (time entries clocked against the job), other costs, and invoices.
const db = require('../db');
const fmt = require('./format');

const STATUSES = [
  ['new_lead', 'New Lead'],
  ['estimate_requested', 'Estimate Requested'],
  ['estimate_scheduled', 'Estimate Scheduled'],
  ['estimate_sent', 'Estimate Sent'],
  ['awaiting_approval', 'Awaiting Approval'],
  ['approved', 'Approved'],
  ['ready_to_schedule', 'Ready to Schedule'],
  ['scheduled', 'Scheduled'],
  ['dispatched', 'Dispatched'],
  ['in_progress', 'In Progress'],
  ['waiting_on_parts', 'Waiting on Parts'],
  ['inspection_required', 'Inspection Required'],
  ['completed', 'Completed'],
  ['invoiced', 'Invoiced'],
  ['paid', 'Paid'],
  ['cancelled', 'Cancelled'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const CLOSED = ['completed', 'invoiced', 'paid', 'cancelled'];
// Statuses a technician may set from the field.
const FIELD_STATUSES = ['dispatched', 'in_progress', 'waiting_on_parts', 'inspection_required'];
const TYPES = ['service', 'repair', 'installation', 'maintenance', 'inspection', 'estimate', 'warranty', 'emergency'];
const DEFAULT_DURATION_MIN = 120;

async function create(data, memberId, tx = db) {
  const title = fmt.clean(data.title, 200);
  if (!title) throw new Error('Job title is required.');
  if (!data.customer_id) throw new Error('Choose a customer.');
  const status = STATUS_LABEL[data.status] ? data.status : data.scheduled_start ? 'scheduled' : 'new_lead';
  const info = await tx
    .prepare(`INSERT INTO jobs (customer_id, property_id, service_request_id, title, description, job_type, priority, status, scheduled_start, scheduled_end, estimated_hours, quoted_price_cents, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      data.customer_id, data.property_id || null, data.service_request_id || null, title, fmt.clean(data.description, 5000),
      TYPES.includes(data.job_type) ? data.job_type : 'service', ['normal', 'high', 'emergency'].includes(data.priority) ? data.priority : 'normal', status,
      data.scheduled_start || null, data.scheduled_end || null, data.estimated_hours === null || data.estimated_hours === undefined ? null : data.estimated_hours,
      data.quoted_price_cents === undefined ? null : data.quoted_price_cents, memberId
    );
  const id = info.lastInsertRowid;
  await tx.prepare('UPDATE jobs SET job_number = ? WHERE id = ?').run(fmt.number('J', id), id);
  await tx.prepare('INSERT INTO job_status_history (job_id, from_status, to_status, member_id) VALUES (?, NULL, ?, ?)').run(id, status, memberId);
  return id;
}

async function update(id, data) {
  const title = fmt.clean(data.title, 200);
  if (!title) throw new Error('Job title is required.');
  await db
    .prepare('UPDATE jobs SET title = ?, description = ?, job_type = ?, priority = ?, property_id = ?, estimated_hours = ?, quoted_price_cents = ?, updated_at = now_text() WHERE id = ?')
    .run(title, fmt.clean(data.description, 5000), TYPES.includes(data.job_type) ? data.job_type : 'service', ['normal', 'high', 'emergency'].includes(data.priority) ? data.priority : 'normal',
      data.property_id || null, data.estimated_hours, data.quoted_price_cents, id);
}

async function get(id) {
  return db
    .prepare(`SELECT j.*, c.name AS "customerName", c.customer_number, c.phone AS "customerPhone", c.email AS "customerEmail", c.account_type,
        p.address, p.city, p.state, p.zip, p.label AS "propertyLabel", p.access_notes, t.name AS "truckName"
      FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN properties p ON p.id = j.property_id LEFT JOIN trucks t ON t.id = j.truck_id WHERE j.id = ?`)
    .get(id);
}

async function details(id) {
  const job = await get(id);
  if (!job) return null;
  const [assignees, notes, materials, files, costs, history, invoices, equipment] = await Promise.all([
    db.prepare('SELECT ja.*, m.name, m.phone FROM job_assignments ja JOIN members m ON m.id = ja.member_id WHERE ja.job_id = ? ORDER BY ja.is_lead DESC, m.name').all(id),
    db.prepare('SELECT n.*, m.name AS "memberName" FROM job_notes n LEFT JOIN members m ON m.id = n.member_id WHERE n.job_id = ? ORDER BY n.id DESC').all(id),
    db.prepare('SELECT jm.*, i.name, i.sku, i.unit, l.name AS "locationName", m.name AS "memberName" FROM job_materials jm JOIN inventory_items i ON i.id = jm.item_id JOIN inventory_locations l ON l.id = jm.location_id LEFT JOIN members m ON m.id = jm.member_id WHERE jm.job_id = ? ORDER BY jm.id').all(id),
    db.prepare('SELECT id, kind, caption, original_name, mime_type, file_size, created_at, member_id FROM job_files WHERE job_id = ? ORDER BY id DESC').all(id),
    db.prepare('SELECT * FROM job_costs WHERE job_id = ? ORDER BY id').all(id),
    db.prepare('SELECT h.*, m.name AS "memberName" FROM job_status_history h LEFT JOIN members m ON m.id = h.member_id WHERE h.job_id = ? ORDER BY h.id DESC').all(id),
    db.prepare('SELECT * FROM invoices WHERE job_id = ? ORDER BY id DESC').all(id),
    db.prepare('SELECT e.* FROM job_equipment je JOIN equipment e ON e.id = je.equipment_id WHERE je.job_id = ?').all(id),
  ]);
  return { ...job, assignees, notes, materials, files, costs, history, invoices, equipment };
}

async function list({ status = null, open = false, q = null, from = null, to = null, assignedTo = null, customerId = null, limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('j.status = ?'); params.push(status); }
  if (open) where.push(`j.status NOT IN (${CLOSED.map(() => '?').join(', ')})`), params.push(...CLOSED);
  if (from) { where.push('j.scheduled_start >= ?'); params.push(from); }
  if (to) { where.push('j.scheduled_start <= ?'); params.push(to); }
  if (assignedTo) { where.push('j.id IN (SELECT job_id FROM job_assignments WHERE member_id = ?)'); params.push(assignedTo); }
  if (customerId) { where.push('j.customer_id = ?'); params.push(customerId); }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    where.push("(LOWER(j.job_number) LIKE ? OR LOWER(j.title) LIKE ? OR LOWER(c.name) LIKE ? OR LOWER(COALESCE(p.address, '')) LIKE ?)");
    params.push(like, like, like, like);
  }
  const max = Math.min(parseInt(limit, 10) || 300, 2000);
  const rows = await db
    .prepare(`SELECT j.*, c.name AS "customerName", c.phone AS "customerPhone", p.address, p.city, t.name AS "truckName"
      FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN properties p ON p.id = j.property_id LEFT JOIN trucks t ON t.id = j.truck_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN j.scheduled_start IS NULL THEN 1 ELSE 0 END, j.scheduled_start, j.id DESC LIMIT ${max}`)
    .all(...params);
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const techs = await db
      .prepare(`SELECT ja.job_id, m.id, m.name FROM job_assignments ja JOIN members m ON m.id = ja.member_id WHERE ja.job_id IN (${ids.map(() => '?').join(', ')}) ORDER BY ja.is_lead DESC, m.name`)
      .all(...ids);
    for (const r of rows) r.techs = techs.filter((t) => t.job_id === r.id);
  }
  return rows;
}

async function isAssigned(jobId, memberId) {
  return Boolean(await db.prepare('SELECT 1 AS ok FROM job_assignments WHERE job_id = ? AND member_id = ?').get(jobId, memberId));
}

async function setStatus(jobId, status, memberId, tx = db) {
  if (!STATUS_LABEL[status]) throw new Error('Unknown job status.');
  const job = await tx.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('Job not found.');
  if (job.status === status) return false;
  await tx.prepare('UPDATE jobs SET status = ?, updated_at = now_text() WHERE id = ?').run(status, jobId);
  await tx.prepare('INSERT INTO job_status_history (job_id, from_status, to_status, member_id) VALUES (?, ?, ?, ?)').run(jobId, job.status, status, memberId);
  return true;
}

function endOf(job) {
  if (job.scheduled_end) return job.scheduled_end;
  const mins = job.estimated_hours ? Math.round(job.estimated_hours * 60) : DEFAULT_DURATION_MIN;
  return fmt.addMinutes(job.scheduled_start, mins);
}

// Other open jobs that overlap [start, end) for any of these technicians.
async function conflicts(memberIds, start, end, excludeJobId = null) {
  if (!start || !memberIds.length) return [];
  const finish = end || endOf({ scheduled_start: start });
  const candidates = await db
    .prepare(`SELECT j.id, j.job_number, j.title, j.scheduled_start, j.scheduled_end, j.estimated_hours, m.id AS "memberId", m.name AS "memberName"
      FROM jobs j JOIN job_assignments ja ON ja.job_id = j.id JOIN members m ON m.id = ja.member_id
      WHERE ja.member_id IN (${memberIds.map(() => '?').join(', ')}) AND j.id <> ? AND j.scheduled_start IS NOT NULL
        AND j.status NOT IN (${CLOSED.map(() => '?').join(', ')}) AND j.scheduled_start < ?`)
    .all(...memberIds, excludeJobId || 0, ...CLOSED, finish);
  return candidates.filter((c) => endOf(c) > start);
}

// Replace the crew / truck / schedule. Returns { added, conflicts }.
async function assign(jobId, { memberIds, leadId = null, truckId = null, start = null, end = null }, actorId) {
  const ids = [...new Set(memberIds.map((x) => parseInt(x, 10)).filter(Boolean))];
  if (start && end && end <= start) throw new Error('The end time must be after the start time.');
  const found = await conflicts(ids, start, end, jobId);
  const added = await db.withTransaction(async (tx) => {
    const job = await tx.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw new Error('Job not found.');
    const before = (await tx.prepare('SELECT member_id FROM job_assignments WHERE job_id = ?').all(jobId)).map((r) => r.member_id);
    await tx.prepare('DELETE FROM job_assignments WHERE job_id = ?').run(jobId);
    for (const id of ids) {
      await tx.prepare('INSERT INTO job_assignments (job_id, member_id, is_lead) VALUES (?, ?, ?)').run(jobId, id, String(id) === String(leadId) || (ids.length === 1) ? 1 : 0);
    }
    await tx.prepare('UPDATE jobs SET truck_id = ?, scheduled_start = ?, scheduled_end = ?, updated_at = now_text() WHERE id = ?').run(truckId || null, start, end, jobId);
    const preSchedule = ['new_lead', 'estimate_requested', 'approved', 'ready_to_schedule'];
    if (start && ids.length && preSchedule.includes(job.status)) await setStatus(jobId, 'scheduled', actorId, tx);
    return ids.filter((id) => !before.includes(id));
  });
  return { added, conflicts: found };
}

async function addNote(jobId, body, memberId) {
  const text = fmt.clean(body, 5000);
  if (!text) throw new Error('Note is empty.');
  await db.prepare('INSERT INTO job_notes (job_id, member_id, body) VALUES (?, ?, ?)').run(jobId, memberId, text);
}

async function complete(jobId, { workPerformed, signatureName, signatureData }, memberId) {
  const work = fmt.clean(workPerformed, 10000);
  if (!work) throw new Error('Describe the work performed before completing the job.');
  let sig = null;
  if (signatureData) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureData) || signatureData.length > 400000) throw new Error('Signature image is invalid.');
    sig = signatureData;
  }
  return db.withTransaction(async (tx) => {
    const job = await tx.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw new Error('Job not found.');
    if (CLOSED.includes(job.status)) throw new Error(`This job is already ${STATUS_LABEL[job.status].toLowerCase()}.`);
    await tx
      .prepare('UPDATE jobs SET work_performed = ?, signature_name = ?, signature_data = ?, signed_at = ?, completed_at = now_text(), updated_at = now_text() WHERE id = ?')
      .run(work, fmt.clean(signatureName, 200), sig, sig || signatureName ? fmt.nowText() : null, jobId);
    await setStatus(jobId, 'completed', memberId, tx);
    if (job.agreement_visit_id) await tx.prepare("UPDATE agreement_visits SET status = 'completed' WHERE id = ?").run(job.agreement_visit_id);
    return job;
  });
}

// Hourly cost of an employee's time: hourly rate, or salary / 2080 h.
function hourlyCost(profile) {
  if (!profile) return 0;
  return profile.pay_type === 'salary' ? Math.round((profile.pay_rate_cents || 0) / 2080) : profile.pay_rate_cents || 0;
}

async function laborFor(jobId) {
  const rows = await db
    .prepare(`SELECT te.*, m.name, ep.pay_type, ep.pay_rate_cents FROM time_entries te JOIN members m ON m.id = te.member_id LEFT JOIN employee_profiles ep ON ep.member_id = te.member_id WHERE te.job_id = ? AND te.clock_out IS NOT NULL AND te.status <> 'rejected'`)
    .all(jobId);
  const breaks = rows.length
    ? await db.prepare(`SELECT entry_id, started_at, ended_at FROM time_breaks WHERE entry_id IN (${rows.map(() => '?').join(', ')})`).all(...rows.map((r) => r.id))
    : [];
  let minutes = 0;
  let cost = 0;
  for (const r of rows) {
    const brk = breaks.filter((b) => b.entry_id === r.id).reduce((s, b) => s + fmt.minutesBetween(b.started_at, b.ended_at || r.clock_out), 0);
    const m = Math.max(0, fmt.minutesBetween(r.clock_in, r.clock_out) - brk);
    minutes += m;
    cost += Math.round((m / 60) * hourlyCost(r));
  }
  return { minutes, cost, entries: rows.length };
}

async function costing(jobId) {
  const mat = await db.prepare('SELECT COALESCE(SUM(quantity * unit_cost_cents), 0) AS cost, COALESCE(SUM(quantity * unit_price_cents), 0) AS price FROM job_materials WHERE job_id = ?').get(jobId);
  const other = await db.prepare('SELECT category, COALESCE(SUM(amount_cents), 0) AS amount FROM job_costs WHERE job_id = ? GROUP BY category').all(jobId);
  const rev = await db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents), 0) AS revenue FROM invoices WHERE job_id = ? AND status <> 'void' AND status <> 'draft'").get(jobId);
  const labor = await laborFor(jobId);
  const by = Object.fromEntries(other.map((o) => [o.category, Number(o.amount)]));
  const materials = Math.round(Number(mat.cost));
  const totalCost = materials + labor.cost + (by.equipment || 0) + (by.subcontractor || 0) + (by.permit || 0) + (by.other || 0);
  const revenue = Number(rev.revenue);
  const job = await db.prepare('SELECT quoted_price_cents FROM jobs WHERE id = ?').get(jobId);
  const price = revenue || (job && job.quoted_price_cents) || 0;
  const grossProfit = price - totalCost;
  return {
    materials, materialsPrice: Math.round(Number(mat.price)), laborMinutes: labor.minutes, labor: labor.cost,
    equipment: by.equipment || 0, subcontractor: by.subcontractor || 0, permit: by.permit || 0, other: by.other || 0,
    totalCost, revenue, price, priceSource: revenue ? 'invoiced' : job && job.quoted_price_cents ? 'quoted' : 'none',
    grossProfit, margin: price ? Math.round((grossProfit / price) * 1000) / 10 : null,
  };
}

module.exports = {
  STATUSES, STATUS_LABEL, CLOSED, FIELD_STATUSES, TYPES, create, update, get, details, list, isAssigned, setStatus, conflicts, assign, addNote, complete,
  hourlyCost, laborFor, costing, endOf,
};
