// Estimates / proposals.
//   draft -> sent (customer link /e/:token) -> approved | rejected | expired
//   approved -> converted (a job is created from it; optional deposit invoice)
//   any non-final estimate can be revised: the copy gets revision+1 and
//   the original becomes 'superseded'.
// Totals are always recomputed from the lines.
const crypto = require('crypto');
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');
const jobs = require('./jobs');

const KINDS = ['equipment', 'material', 'labor', 'permit', 'fee', 'other'];
const STATUSES = ['draft', 'sent', 'approved', 'rejected', 'expired', 'superseded', 'converted'];
const EDITABLE = ['draft', 'sent'];

function token() {
  return crypto.randomBytes(24).toString('hex');
}

async function get(id, tx = db) {
  return tx
    .prepare(`SELECT e.*, c.name AS "customerName", c.customer_number, c.email AS "customerEmail", c.phone AS "customerPhone", c.billing_address,
        p.address, p.city, p.state, p.zip, j.job_number, m.name AS "createdByName"
      FROM estimates e JOIN customers c ON c.id = e.customer_id LEFT JOIN properties p ON p.id = e.property_id LEFT JOIN jobs j ON j.id = e.job_id LEFT JOIN members m ON m.id = e.created_by WHERE e.id = ?`)
    .get(id);
}

async function details(id) {
  const e = await get(id);
  if (!e) return null;
  e.lines = await db.prepare('SELECT * FROM estimate_lines WHERE estimate_id = ? ORDER BY position, id').all(id);
  e.revisions = await db.prepare('SELECT id, estimate_number, revision, status FROM estimates WHERE id = ? OR parent_estimate_id = ? OR id = ? ORDER BY revision').all(e.parent_estimate_id || e.id, e.parent_estimate_id || e.id, e.parent_estimate_id || 0);
  e.depositInvoice = await db.prepare("SELECT id, invoice_number, status, total_cents FROM invoices WHERE estimate_id = ? AND job_id IS NULL AND status <> 'void'").get(id);
  return e;
}

async function byToken(t) {
  if (!t || !/^[a-f0-9]{48}$/.test(t)) return null;
  const row = await db.prepare('SELECT id FROM estimates WHERE public_token = ?').get(t);
  return row ? details(row.id) : null;
}

async function list({ status = null, open = false, customerId = null, q = null, limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('e.status = ?'); params.push(status); }
  if (open) where.push("e.status IN ('draft','sent','approved')");
  if (customerId) { where.push('e.customer_id = ?'); params.push(customerId); }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    where.push('(LOWER(e.estimate_number) LIKE ? OR LOWER(e.title) LIKE ? OR LOWER(c.name) LIKE ?)');
    params.push(like, like, like);
  }
  const max = Math.min(parseInt(limit, 10) || 300, 2000);
  return db
    .prepare(`SELECT e.*, c.name AS "customerName" FROM estimates e JOIN customers c ON c.id = e.customer_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT ${max}`)
    .all(...params);
}

async function recalc(tx, id) {
  const e = await tx.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  const lines = await tx.prepare('SELECT * FROM estimate_lines WHERE estimate_id = ?').all(id);
  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  const taxableGross = lines.filter((l) => l.taxable).reduce((s, l) => s + l.amount_cents, 0);
  const discount = Math.min(Math.max(0, e.discount_cents), subtotal);
  const taxable = subtotal ? Math.round(taxableGross - (discount * taxableGross) / subtotal) : 0;
  const tax = Math.round((taxable * e.tax_rate_bp) / 10000);
  await tx
    .prepare('UPDATE estimates SET subtotal_cents = ?, discount_cents = ?, taxable_cents = ?, tax_cents = ?, total_cents = ?, updated_at = now_text() WHERE id = ?')
    .run(subtotal, discount, taxable, tax, subtotal - discount + tax, id);
}

async function create(data, memberId) {
  const title = fmt.clean(data.title, 200);
  if (!title) throw new Error('Estimate title is required.');
  if (!data.customer_id) throw new Error('Choose a customer.');
  const validDays = await settings.getInt('estimate_valid_days', 30);
  return db.withTransaction(async (tx) => {
    const info = await tx
      .prepare(`INSERT INTO estimates (customer_id, property_id, service_request_id, title, scope, expires_on, tax_rate_bp, terms, warranty, public_token, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data.customer_id, data.property_id || null, data.service_request_id || null, title, fmt.clean(data.scope, 10000), fmt.addDays(fmt.today(), validDays),
        await settings.getInt('default_tax_rate_bp', 0), await settings.get('estimate_terms', null), await settings.get('estimate_warranty', null), token(), memberId);
    const id = info.lastInsertRowid;
    await tx.prepare('UPDATE estimates SET estimate_number = ? WHERE id = ?').run(fmt.number('E', id), id);
    return id;
  });
}

async function requireEditable(tx, id) {
  const e = await tx.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  if (!e) throw new Error('Estimate not found.');
  if (!EDITABLE.includes(e.status)) throw new Error(`A ${e.status} estimate can't be changed. Create a revision instead.`);
  return e;
}

async function update(id, data) {
  const title = fmt.clean(data.title, 200);
  if (!title) throw new Error('Estimate title is required.');
  const discount = fmt.toCents(data.discount) || 0;
  const deposit = fmt.toCents(data.deposit) || 0;
  const rate = fmt.toNumber(data.tax_rate);
  if (discount < 0 || deposit < 0) throw new Error('Amounts cannot be negative.');
  if (rate !== null && (rate < 0 || rate > 50)) throw new Error('Tax rate must be between 0% and 50%.');
  await db.withTransaction(async (tx) => {
    await requireEditable(tx, id);
    await tx
      .prepare('UPDATE estimates SET title = ?, scope = ?, property_id = ?, expires_on = ?, discount_cents = ?, tax_rate_bp = ?, deposit_cents = ?, payment_schedule = ?, terms = ?, warranty = ? WHERE id = ?')
      .run(title, fmt.clean(data.scope, 10000), data.property_id || null, fmt.dateOnly(data.expires_on), discount, rate === null ? 0 : Math.round(rate * 100), deposit,
        fmt.clean(data.payment_schedule, 1000), fmt.clean(data.terms, 4000), fmt.clean(data.warranty, 4000), id);
    await recalc(tx, id);
  });
}

async function addLine(id, { kind, itemId, description, quantity, unitPriceCents, taxable }) {
  await db.withTransaction(async (tx) => {
    await requireEditable(tx, id);
    let desc = fmt.clean(description, 500);
    let price = unitPriceCents;
    if (itemId) {
      const item = await tx.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId);
      if (!item) throw new Error('Item not found.');
      desc = desc || item.name;
      if (price === null || price === undefined) price = item.price_cents;
    }
    if (!desc) throw new Error('Line description is required.');
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');
    if (!Number.isInteger(price) || price < 0) throw new Error('Enter a unit price.');
    const pos = await tx.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM estimate_lines WHERE estimate_id = ?').get(id);
    await tx
      .prepare('INSERT INTO estimate_lines (estimate_id, kind, description, quantity, unit_price_cents, amount_cents, taxable, item_id, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, KINDS.includes(kind) ? kind : 'other', desc, qty, price, Math.round(qty * price), taxable ? 1 : 0, itemId || null, pos.p);
    await recalc(tx, id);
  });
}

async function removeLine(id, lineId) {
  await db.withTransaction(async (tx) => {
    await requireEditable(tx, id);
    await tx.prepare('DELETE FROM estimate_lines WHERE id = ? AND estimate_id = ?').run(lineId, id);
    await recalc(tx, id);
  });
}

async function markSent(id) {
  const e = await db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  if (!e) throw new Error('Estimate not found.');
  if (!EDITABLE.includes(e.status)) throw new Error(`A ${e.status} estimate can't be sent.`);
  const n = await db.prepare('SELECT COUNT(*) AS c FROM estimate_lines WHERE estimate_id = ?').get(id);
  if (!n.c || e.total_cents <= 0) throw new Error('Add at least one priced line first.');
  await db.prepare("UPDATE estimates SET status = 'sent', sent_at = now_text(), updated_at = now_text() WHERE id = ?").run(id);
}

// Customer decision (from the public link, or recorded by the office).
async function decide(id, { approve, name, signatureData, reason }) {
  return db.withTransaction(async (tx) => {
    const e = await tx.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
    if (!e) throw new Error('Estimate not found.');
    if (!EDITABLE.includes(e.status)) throw new Error(`This estimate is ${e.status} and can no longer be ${approve ? 'approved' : 'declined'}.`);
    if (e.expires_on && e.expires_on < fmt.today()) {
      await tx.prepare("UPDATE estimates SET status = 'expired' WHERE id = ?").run(id);
      throw new Error('This estimate has expired. Please contact us for an updated price.');
    }
    if (approve) {
      const who = fmt.clean(name, 200);
      if (!who) throw new Error('Type your full name to approve.');
      let sig = null;
      if (signatureData) {
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureData) || signatureData.length > 400000) throw new Error('Signature image is invalid.');
        sig = signatureData;
      }
      await tx.prepare("UPDATE estimates SET status = 'approved', approved_name = ?, signature_data = ?, decided_at = now_text(), updated_at = now_text() WHERE id = ?").run(who, sig, id);
    } else {
      await tx.prepare("UPDATE estimates SET status = 'rejected', rejection_reason = ?, decided_at = now_text(), updated_at = now_text() WHERE id = ?").run(fmt.clean(reason, 1000), id);
    }
    return e;
  });
}

async function revise(id, memberId) {
  return db.withTransaction(async (tx) => {
    const e = await tx.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
    if (!e) throw new Error('Estimate not found.');
    if (['converted', 'superseded'].includes(e.status)) throw new Error(`A ${e.status} estimate can't be revised.`);
    const rootId = e.parent_estimate_id || e.id;
    const root = await tx.prepare('SELECT estimate_number FROM estimates WHERE id = ?').get(rootId);
    const maxRev = await tx.prepare('SELECT MAX(revision) AS r FROM estimates WHERE id = ? OR parent_estimate_id = ?').get(rootId, rootId);
    const rev = (maxRev.r || 1) + 1;
    const validDays = await settings.getInt('estimate_valid_days', 30);
    const info = await tx
      .prepare(`INSERT INTO estimates (estimate_number, revision, parent_estimate_id, customer_id, property_id, service_request_id, title, scope, expires_on, tax_rate_bp, discount_cents, deposit_cents, payment_schedule, terms, warranty, public_token, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${root.estimate_number}-R${rev}`, rev, rootId, e.customer_id, e.property_id, e.service_request_id, e.title, e.scope, fmt.addDays(fmt.today(), validDays), e.tax_rate_bp, e.discount_cents,
        e.deposit_cents, e.payment_schedule, e.terms, e.warranty, token(), memberId);
    const newId = info.lastInsertRowid;
    const lines = await tx.prepare('SELECT * FROM estimate_lines WHERE estimate_id = ? ORDER BY position, id').all(id);
    for (const l of lines) {
      await tx
        .prepare('INSERT INTO estimate_lines (estimate_id, kind, description, quantity, unit_price_cents, amount_cents, taxable, item_id, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId, l.kind, l.description, l.quantity, l.unit_price_cents, l.amount_cents, l.taxable, l.item_id, l.position);
    }
    await recalc(tx, newId);
    await tx.prepare("UPDATE estimates SET status = 'superseded', updated_at = now_text() WHERE id = ?").run(id);
    return newId;
  });
}

const JOB_TYPE = { equipment: 'installation' };

async function convertToJob(id, memberId) {
  return db.withTransaction(async (tx) => {
    const e = await tx.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
    if (!e) throw new Error('Estimate not found.');
    if (e.job_id) return e.job_id;
    if (e.status !== 'approved') throw new Error('Only approved estimates can become jobs.');
    const hasEquipment = await tx.prepare("SELECT 1 AS x FROM estimate_lines WHERE estimate_id = ? AND kind = 'equipment'").get(id);
    const laborHours = await tx.prepare("SELECT COALESCE(SUM(quantity), 0) AS h FROM estimate_lines WHERE estimate_id = ? AND kind = 'labor'").get(id);
    const jobId = await jobs.create({
      customer_id: e.customer_id, property_id: e.property_id, service_request_id: e.service_request_id, title: e.title, description: e.scope,
      job_type: hasEquipment ? JOB_TYPE.equipment : 'repair', status: 'approved', estimated_hours: Number(laborHours.h) || null,
    }, memberId, tx);
    await tx.prepare('UPDATE jobs SET estimate_id = ? WHERE id = ?').run(id, jobId);
    await tx.prepare("UPDATE estimates SET status = 'converted', job_id = ?, updated_at = now_text() WHERE id = ?").run(jobId, id);
    if (e.service_request_id) await tx.prepare("UPDATE service_requests SET status = 'converted', job_id = COALESCE(job_id, ?) WHERE id = ?").run(jobId, e.service_request_id);
    return jobId;
  });
}

async function expireOld() {
  const r = await db.prepare("UPDATE estimates SET status = 'expired', updated_at = now_text() WHERE status = 'sent' AND expires_on IS NOT NULL AND expires_on < ?").run(fmt.today());
  return r.changes || 0;
}

// Change orders on a job (extra work found on site).
async function addChangeOrder(jobId, { description, amountCents }, memberId) {
  const desc = fmt.clean(description, 1000);
  if (!desc) throw new Error('Describe the change.');
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error('Enter the price change (negative for a reduction).');
  return db.withTransaction(async (tx) => {
    const n = await tx.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM change_orders WHERE job_id = ?').get(jobId);
    const info = await tx.prepare('INSERT INTO change_orders (job_id, number, description, amount_cents, created_by) VALUES (?, ?, ?, ?, ?)').run(jobId, n.n, desc, amountCents, memberId);
    return info.lastInsertRowid;
  });
}

async function decideChangeOrder(jobId, coId, { approve, name, signatureData }) {
  const co = await db.prepare("SELECT * FROM change_orders WHERE id = ? AND job_id = ? AND status = 'pending'").get(coId, jobId);
  if (!co) throw new Error('Change order not found or already decided.');
  if (approve && !fmt.clean(name)) throw new Error("Enter the customer's name for the approval.");
  if (signatureData && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureData) || signatureData.length > 400000)) throw new Error('Signature image is invalid.');
  await db.prepare('UPDATE change_orders SET status = ?, approved_name = ?, signature_data = ?, decided_at = now_text() WHERE id = ?').run(approve ? 'approved' : 'rejected', fmt.clean(name, 200), signatureData || null, co.id);
  return co;
}

module.exports = { KINDS, STATUSES, get, details, byToken, list, create, update, addLine, removeLine, markSent, decide, revise, convertToJob, expireOld, addChangeOrder, decideChangeOrder };
