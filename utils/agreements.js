// Maintenance plans (templates) and customer maintenance agreements.
// An agreement covers a property (and optionally specific equipment) for
// a term, with a number of visits spread evenly across it. Each visit
// becomes a maintenance job when it comes due (daily automation or the
// "create job" button); completing that job completes the visit.
const db = require('../db');
const fmt = require('./format');
const jobs = require('./jobs');

function addMonths(date, months) {
  const d = new Date(String(date).slice(0, 10) + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- plans
async function listPlans({ activeOnly = false } = {}) {
  return db.prepare(`SELECT * FROM maintenance_plans ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY active DESC, name`).all();
}

async function savePlan(id, d) {
  const name = fmt.clean(d.name, 100);
  if (!name) throw new Error('Plan name is required.');
  const visits = parseInt(d.visits_per_year, 10);
  const term = parseInt(d.term_months, 10) || 12;
  const price = fmt.toCents(d.price);
  if (!(visits >= 1 && visits <= 12)) throw new Error('Visits per year must be 1-12.');
  if (!(term >= 1 && term <= 60)) throw new Error('Term must be 1-60 months.');
  if (price === null || price < 0) throw new Error('Enter the plan price.');
  const dup = await db.prepare('SELECT id FROM maintenance_plans WHERE LOWER(name) = LOWER(?) AND id <> ?').get(name, id || 0);
  if (dup) throw new Error('A plan with that name exists.');
  const vals = [name, fmt.clean(d.description, 1000), fmt.clean(d.included_services, 4000), visits, price, term];
  if (id) await db.prepare('UPDATE maintenance_plans SET name = ?, description = ?, included_services = ?, visits_per_year = ?, price_cents = ?, term_months = ?, active = ? WHERE id = ?').run(...vals, d.active === '0' ? 0 : 1, id);
  else await db.prepare('INSERT INTO maintenance_plans (name, description, included_services, visits_per_year, price_cents, term_months) VALUES (?, ?, ?, ?, ?, ?)').run(...vals);
}

// ---------------------------------------------------------------- agreements
async function list({ status = null, customerId = null } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (customerId) { where.push('a.customer_id = ?'); params.push(customerId); }
  return db
    .prepare(`SELECT a.*, c.name AS "customerName", p.address,
        (SELECT MIN(due_date) FROM agreement_visits v WHERE v.agreement_id = a.id AND v.status IN ('due','scheduled')) AS "nextVisit"
      FROM maintenance_agreements a JOIN customers c ON c.id = a.customer_id LEFT JOIN properties p ON p.id = a.property_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE a.status WHEN 'active' THEN 0 ELSE 1 END, a.end_date`)
    .all(...params);
}

async function get(id) {
  const a = await db
    .prepare(`SELECT a.*, c.name AS "customerName", c.customer_number, c.email AS "customerEmail", c.phone AS "customerPhone", p.address, p.city, p.state, p.zip, mp.name AS "planName"
      FROM maintenance_agreements a JOIN customers c ON c.id = a.customer_id LEFT JOIN properties p ON p.id = a.property_id LEFT JOIN maintenance_plans mp ON mp.id = a.plan_id WHERE a.id = ?`)
    .get(id);
  if (!a) return null;
  a.visits = await db.prepare('SELECT v.*, j.job_number, j.status AS "jobStatus", j.completed_at FROM agreement_visits v LEFT JOIN jobs j ON j.id = v.job_id WHERE v.agreement_id = ? ORDER BY v.visit_number').all(id);
  a.equipment = await db.prepare('SELECT e.* FROM agreement_equipment ae JOIN equipment e ON e.id = ae.equipment_id WHERE ae.agreement_id = ?').all(id);
  a.invoices = await db.prepare('SELECT id, invoice_number, status, total_cents FROM invoices WHERE agreement_id = ? ORDER BY id').all(id);
  return a;
}

async function insertAgreement(tx, d, memberId) {
  const months = d.termMonths;
  const end = fmt.addDays(addMonths(d.startDate, months), -1);
  const info = await tx
    .prepare(`INSERT INTO maintenance_agreements (customer_id, property_id, plan_id, name, included_services, start_date, end_date, visits_per_year, price_cents, auto_renew, renewed_from_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.customerId, d.propertyId, d.planId, d.name, d.includedServices, d.startDate, end, d.visitsPerYear, d.priceCents, d.autoRenew ? 1 : 0, d.renewedFromId || null, d.notes || null, memberId);
  const id = info.lastInsertRowid;
  await tx.prepare('UPDATE maintenance_agreements SET agreement_number = ? WHERE id = ?').run(fmt.number('MA', id), id);
  const total = Math.max(1, Math.round((d.visitsPerYear * months) / 12));
  const spacing = months / total;
  for (let i = 0; i < total; i++) {
    await tx.prepare('INSERT INTO agreement_visits (agreement_id, visit_number, due_date) VALUES (?, ?, ?)').run(id, i + 1, addMonths(d.startDate, Math.floor(i * spacing)));
  }
  for (const eq of d.equipmentIds || []) await tx.prepare('INSERT INTO agreement_equipment (agreement_id, equipment_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(id, eq);
  return id;
}

async function create(d, memberId) {
  const customer = await db.prepare('SELECT id FROM customers WHERE id = ?').get(d.customer_id);
  if (!customer) throw new Error('Customer not found.');
  const plan = d.plan_id ? await db.prepare('SELECT * FROM maintenance_plans WHERE id = ?').get(d.plan_id) : null;
  const property = d.property_id ? await db.prepare('SELECT * FROM properties WHERE id = ? AND customer_id = ?').get(d.property_id, customer.id) : null;
  if (!property) throw new Error('Choose the property this agreement covers.');
  const start = fmt.dateOnly(d.start_date) || fmt.today();
  const visits = parseInt(d.visits_per_year, 10) || (plan && plan.visits_per_year);
  const months = parseInt(d.term_months, 10) || (plan && plan.term_months) || 12;
  const price = d.price !== undefined && d.price !== '' ? fmt.toCents(d.price) : plan ? plan.price_cents : null;
  const name = fmt.clean(d.name, 150) || (plan && plan.name);
  if (!name) throw new Error('Choose a plan or name the agreement.');
  if (!(visits >= 1 && visits <= 12)) throw new Error('Visits per year must be 1-12.');
  if (price === null || price < 0) throw new Error('Enter the price.');
  const allowedEq = new Set((await db.prepare('SELECT id FROM equipment WHERE property_id = ?').all(property.id)).map((e) => e.id));
  const equipmentIds = [].concat(d.equipment_ids || []).map((x) => parseInt(x, 10)).filter((x) => allowedEq.has(x));
  return db.withTransaction((tx) => insertAgreement(tx, {
    customerId: customer.id, propertyId: property.id, planId: plan ? plan.id : null, name, includedServices: fmt.clean(d.included_services, 4000) || (plan && plan.included_services),
    startDate: start, termMonths: months, visitsPerYear: visits, priceCents: price, autoRenew: d.auto_renew === '1', notes: fmt.clean(d.notes, 2000), equipmentIds,
  }, memberId));
}

async function renew(id, memberId) {
  return db.withTransaction(async (tx) => {
    const a = await tx.prepare('SELECT * FROM maintenance_agreements WHERE id = ?').get(id);
    if (!a) throw new Error('Agreement not found.');
    if (!['active', 'expired'].includes(a.status)) throw new Error(`A ${a.status} agreement can't be renewed.`);
    const already = await tx.prepare('SELECT id FROM maintenance_agreements WHERE renewed_from_id = ?').get(id);
    if (already) return already.id;
    const months = Math.max(1, Math.round((fmt.parseTs(fmt.addDays(a.end_date, 1) + ' 00:00:00') - fmt.parseTs(a.start_date + ' 00:00:00')) / (30.44 * 86400000)));
    const plan = a.plan_id ? await tx.prepare('SELECT * FROM maintenance_plans WHERE id = ? AND active = 1').get(a.plan_id) : null;
    const eq = (await tx.prepare('SELECT equipment_id FROM agreement_equipment WHERE agreement_id = ?').all(id)).map((r) => r.equipment_id);
    const newId = await insertAgreement(tx, {
      customerId: a.customer_id, propertyId: a.property_id, planId: a.plan_id, name: a.name, includedServices: a.included_services, startDate: fmt.addDays(a.end_date, 1),
      termMonths: months, visitsPerYear: a.visits_per_year, priceCents: plan ? plan.price_cents : a.price_cents, autoRenew: Boolean(a.auto_renew), renewedFromId: a.id, notes: a.notes, equipmentIds: eq,
    }, memberId);
    await tx.prepare("UPDATE maintenance_agreements SET status = 'renewed' WHERE id = ?").run(id);
    await tx.prepare("UPDATE agreement_visits SET status = 'skipped' WHERE agreement_id = ? AND status = 'due'").run(id);
    return newId;
  });
}

async function cancel(id, reason) {
  if (!fmt.clean(reason)) throw new Error('A reason is required.');
  const a = await db.prepare('SELECT * FROM maintenance_agreements WHERE id = ?').get(id);
  if (!a || a.status !== 'active') throw new Error('Only active agreements can be cancelled.');
  await db.prepare("UPDATE maintenance_agreements SET status = 'cancelled', notes = COALESCE(notes, '') || ? WHERE id = ?").run(`\n[Cancelled ${fmt.today()}: ${reason}]`, id);
  await db.prepare("UPDATE agreement_visits SET status = 'skipped' WHERE agreement_id = ? AND status = 'due'").run(id);
}

async function createVisitJob(visitId, memberId) {
  return db.withTransaction(async (tx) => {
    const v = await tx
      .prepare('SELECT v.*, a.customer_id, a.property_id, a.name, a.agreement_number, a.included_services, a.status AS "agreementStatus" FROM agreement_visits v JOIN maintenance_agreements a ON a.id = v.agreement_id WHERE v.id = ?')
      .get(visitId);
    if (!v) throw new Error('Visit not found.');
    if (v.job_id) return v.job_id;
    if (v.agreementStatus !== 'active') throw new Error('The agreement is not active.');
    const eq = await tx.prepare('SELECT e.equipment_type, e.manufacturer, e.serial_number FROM agreement_equipment ae JOIN equipment e ON e.id = ae.equipment_id WHERE ae.agreement_id = ?').all(v.agreement_id);
    const desc = [`Maintenance visit ${v.visit_number} under ${v.agreement_number} (due ${v.due_date}).`, v.included_services ? `Included: ${v.included_services}` : null,
      eq.length ? `Covered equipment: ${eq.map((e) => [e.equipment_type, e.manufacturer, e.serial_number && '#' + e.serial_number].filter(Boolean).join(' ')).join('; ')}` : null].filter(Boolean).join('\n');
    const jobId = await jobs.create({ customer_id: v.customer_id, property_id: v.property_id, title: `${v.name} - visit ${v.visit_number}`, description: desc, job_type: 'maintenance', status: 'ready_to_schedule', estimated_hours: 1.5, quoted_price_cents: 0 }, memberId, tx);
    await tx.prepare('UPDATE jobs SET agreement_visit_id = ? WHERE id = ?').run(visitId, jobId);
    await tx.prepare("UPDATE agreement_visits SET job_id = ?, status = 'scheduled' WHERE id = ?").run(jobId, visitId);
    const eqIds = await tx.prepare('SELECT equipment_id FROM agreement_equipment WHERE agreement_id = ?').all(v.agreement_id);
    for (const e of eqIds) await tx.prepare('INSERT INTO job_equipment (job_id, equipment_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(jobId, e.equipment_id);
    return jobId;
  });
}

async function visitsComingDue(leadDays) {
  return db
    .prepare(`SELECT v.*, a.agreement_number, c.name AS "customerName" FROM agreement_visits v JOIN maintenance_agreements a ON a.id = v.agreement_id JOIN customers c ON c.id = a.customer_id
      WHERE a.status = 'active' AND v.status = 'due' AND v.job_id IS NULL AND v.due_date <= ? ORDER BY v.due_date`)
    .all(fmt.addDays(fmt.today(), leadDays));
}

async function endingWithin(days) {
  return db
    .prepare("SELECT a.*, c.name AS \"customerName\" FROM maintenance_agreements a JOIN customers c ON c.id = a.customer_id WHERE a.status = 'active' AND a.end_date <= ? ORDER BY a.end_date")
    .all(fmt.addDays(fmt.today(), days));
}

module.exports = { addMonths, listPlans, savePlan, list, get, create, renew, cancel, createVisitJob, visitsComingDue, endingWithin };
