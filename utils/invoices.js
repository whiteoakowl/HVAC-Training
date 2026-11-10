// Invoices and payments.
//   draft  -> editable; no accounting effect
//   issued -> posts Dr AR / Cr revenue + sales tax; job -> Invoiced
//   partial/paid -> each payment posts Dr Cash / Cr AR; job -> Paid
//   void   -> only when no payments; posts a reversing entry
// Totals are always recomputed from the lines (recalc), never typed in.
const db = require('../db');
const fmt = require('./format');
const accounting = require('./accounting');
const settings = require('./settings');
const jobs = require('./jobs');

const KINDS = ['labor', 'material', 'equipment', 'fee', 'other'];
const METHODS = ['cash', 'check', 'card', 'ach', 'other'];
const REVENUE_ACCOUNT = { labor: '4000', fee: '4000', other: '4000', material: '4100', equipment: '4100' };

async function get(id, tx = db) {
  return tx
    .prepare(`SELECT i.*, c.name AS "customerName", c.customer_number, c.email AS "customerEmail", c.phone AS "customerPhone", c.billing_address, j.job_number, j.title AS "jobTitle"
      FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN jobs j ON j.id = i.job_id WHERE i.id = ?`)
    .get(id);
}

async function details(id) {
  const inv = await get(id);
  if (!inv) return null;
  inv.lines = await db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id').all(id);
  inv.payments = await db.prepare('SELECT p.*, m.name AS "recordedByName" FROM payments p LEFT JOIN members m ON m.id = p.recorded_by WHERE p.invoice_id = ? ORDER BY p.id').all(id);
  inv.balance = inv.total_cents - inv.amount_paid_cents;
  return inv;
}

async function list({ status = null, customerId = null, q = null, overdue = false, limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (status === 'open') where.push("i.status IN ('issued','partial')");
  else if (status) { where.push('i.status = ?'); params.push(status); }
  if (customerId) { where.push('i.customer_id = ?'); params.push(customerId); }
  if (overdue) { where.push("i.status IN ('issued','partial') AND i.due_date < ?"); params.push(fmt.today()); }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    where.push("(LOWER(COALESCE(i.invoice_number, '')) LIKE ? OR LOWER(c.name) LIKE ? OR LOWER(COALESCE(j.job_number, '')) LIKE ?)");
    params.push(like, like, like);
  }
  const max = Math.min(parseInt(limit, 10) || 300, 2000);
  return db
    .prepare(`SELECT i.*, c.name AS "customerName", j.job_number FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN jobs j ON j.id = i.job_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC LIMIT ${max}`)
    .all(...params);
}

async function recalc(tx, id) {
  const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  const lines = await tx.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(id);
  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  const taxableGross = lines.filter((l) => l.taxable).reduce((s, l) => s + l.amount_cents, 0);
  const discount = Math.min(Math.max(0, inv.discount_cents), subtotal);
  // The discount reduces the taxable base proportionally.
  const taxable = subtotal ? Math.round(taxableGross - (discount * taxableGross) / subtotal) : 0;
  const tax = Math.round((taxable * inv.tax_rate_bp) / 10000);
  const total = subtotal - discount + tax;
  await tx
    .prepare('UPDATE invoices SET subtotal_cents = ?, discount_cents = ?, taxable_cents = ?, tax_cents = ?, total_cents = ?, updated_at = now_text() WHERE id = ?')
    .run(subtotal, discount, taxable, tax, total, id);
}

async function addLine(tx, invoiceId, { kind, description, quantity, unitPriceCents, taxable = true }) {
  const desc = fmt.clean(description, 500);
  if (!desc) throw new Error('Line description is required.');
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');
  if (!Number.isInteger(unitPriceCents)) throw new Error('Enter a unit price.');
  const pos = await tx.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM invoice_lines WHERE invoice_id = ?').get(invoiceId);
  await tx
    .prepare('INSERT INTO invoice_lines (invoice_id, kind, description, quantity, unit_price_cents, amount_cents, taxable, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(invoiceId, KINDS.includes(kind) ? kind : 'other', desc, qty, unitPriceCents, Math.round(qty * unitPriceCents), taxable ? 1 : 0, pos.p);
}

async function createDraft(tx, { customerId, jobId = null, memberId }) {
  const terms = await settings.getInt('invoice_terms_days', 30);
  const taxBp = await settings.getInt('default_tax_rate_bp', 0);
  const info = await tx
    .prepare("INSERT INTO invoices (customer_id, job_id, status, tax_rate_bp, terms, notes, created_by) VALUES (?, ?, 'draft', ?, ?, ?, ?)")
    .run(customerId, jobId, taxBp, `Net ${terms}`, await settings.get('invoice_footer', null), memberId);
  const id = info.lastInsertRowid;
  await tx.prepare('UPDATE invoices SET invoice_number = ? WHERE id = ?').run(fmt.number('INV', id), id);
  return id;
}

// Draft invoice from a job: quoted price as one line if the job has one,
// otherwise actual labor (clocked time, or estimate) at the labor rate
// plus each material at its selling price. Always reviewed before issue.
async function createFromJob(jobId, memberId) {
  const existing = await db.prepare("SELECT id FROM invoices WHERE job_id = ? AND status <> 'void'").get(jobId);
  if (existing) return { id: existing.id, created: false };
  const job = await jobs.get(jobId);
  if (!job) throw new Error('Job not found.');
  const labor = await jobs.laborFor(jobId);
  const rate = await settings.getInt('labor_rate_cents', 0);
  const materials = await db.prepare('SELECT jm.*, i.name, i.unit FROM job_materials jm JOIN inventory_items i ON i.id = jm.item_id WHERE jm.job_id = ? ORDER BY jm.id').all(jobId);
  const costs = await db.prepare('SELECT * FROM job_costs WHERE job_id = ? ORDER BY id').all(jobId);
  const id = await db.withTransaction(async (tx) => {
    const invId = await createDraft(tx, { customerId: job.customer_id, jobId, memberId });
    if (job.quoted_price_cents) {
      await addLine(tx, invId, { kind: 'labor', description: `${job.title} (as quoted)`, quantity: 1, unitPriceCents: job.quoted_price_cents });
    } else {
      const hrs = labor.minutes ? Math.round((labor.minutes / 60) * 100) / 100 : job.estimated_hours || 0;
      if (hrs > 0) await addLine(tx, invId, { kind: 'labor', description: `Labor - ${job.title}${labor.minutes ? '' : ' (estimated hours)'}`, quantity: hrs, unitPriceCents: rate });
      for (const m of materials) await addLine(tx, invId, { kind: 'material', description: `${m.name}`, quantity: Number(m.quantity), unitPriceCents: m.unit_price_cents });
      for (const c of costs.filter((x) => x.category === 'permit')) await addLine(tx, invId, { kind: 'fee', description: `Permit: ${c.description}`, quantity: 1, unitPriceCents: c.amount_cents, taxable: false });
    }
    await recalc(tx, invId);
    return invId;
  });
  return { id, created: true };
}

async function requireDraft(tx, id) {
  const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) throw new Error('Invoice not found.');
  if (inv.status !== 'draft') throw new Error('Only draft invoices can be edited. Void and re-create to change an issued invoice.');
  return inv;
}

async function editDraft(id, { discountCents, taxRateBp, terms, notes, dueDate }) {
  await db.withTransaction(async (tx) => {
    await requireDraft(tx, id);
    if (discountCents !== null && discountCents < 0) throw new Error('Discount cannot be negative.');
    if (taxRateBp !== null && (taxRateBp < 0 || taxRateBp > 5000)) throw new Error('Tax rate must be between 0% and 50%.');
    await tx
      .prepare('UPDATE invoices SET discount_cents = ?, tax_rate_bp = ?, terms = ?, notes = ?, due_date = ? WHERE id = ?')
      .run(discountCents || 0, taxRateBp || 0, fmt.clean(terms, 200), fmt.clean(notes, 2000), fmt.dateOnly(dueDate), id);
    await recalc(tx, id);
  });
}

async function addDraftLine(id, line) {
  await db.withTransaction(async (tx) => {
    await requireDraft(tx, id);
    await addLine(tx, id, line);
    await recalc(tx, id);
  });
}

async function removeDraftLine(id, lineId) {
  await db.withTransaction(async (tx) => {
    await requireDraft(tx, id);
    await tx.prepare('DELETE FROM invoice_lines WHERE id = ? AND invoice_id = ?').run(lineId, id);
    await recalc(tx, id);
  });
}

async function createBlank(customerId, memberId) {
  return db.withTransaction(async (tx) => {
    const id = await createDraft(tx, { customerId, memberId });
    await recalc(tx, id);
    return id;
  });
}

async function issue(id, memberId, issueDate = null) {
  return db.withTransaction(async (tx) => {
    const inv = await requireDraft(tx, id);
    await recalc(tx, id);
    const fresh = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    const lines = await tx.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(id);
    if (!lines.length || fresh.total_cents <= 0) throw new Error('Add at least one line with a positive total before issuing.');
    const date = fmt.dateOnly(issueDate) || fmt.today();
    const termsDays = parseInt(String(fresh.terms || '').replace(/\D/g, ''), 10);
    const due = fresh.due_date || fmt.addDays(date, Number.isFinite(termsDays) ? termsDays : await settings.getInt('invoice_terms_days', 30));
    const revenue = {};
    for (const l of lines) revenue[REVENUE_ACCOUNT[l.kind]] = (revenue[REVENUE_ACCOUNT[l.kind]] || 0) + l.amount_cents;
    const credits = Object.entries(revenue).map(([code, amt]) => (amt >= 0 ? { code, credit: amt } : { code, debit: -amt }));
    const entryId = await accounting.post(tx, {
      date, memo: `Invoice ${fresh.invoice_number}`, sourceType: 'invoice', sourceId: id, memberId,
      lines: [{ code: '1100', debit: fresh.total_cents }, ...credits, { code: '4900', debit: fresh.discount_cents }, { code: '2100', credit: fresh.tax_cents }],
    });
    await tx.prepare("UPDATE invoices SET status = 'issued', issue_date = ?, due_date = ?, journal_entry_id = ?, updated_at = now_text() WHERE id = ?").run(date, due, entryId, id);
    if (inv.job_id) {
      const job = await tx.prepare('SELECT status FROM jobs WHERE id = ?').get(inv.job_id);
      if (job && ['completed', 'in_progress', 'inspection_required'].includes(job.status)) await jobs.setStatus(inv.job_id, 'invoiced', memberId, tx);
    }
    return entryId;
  });
}

async function recordPayment(id, { amountCents, method, reference, receivedOn }, memberId) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Payment amount must be greater than zero.');
  if (!METHODS.includes(method)) throw new Error('Choose a payment method.');
  return db.withTransaction(async (tx) => {
    const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) throw new Error('Invoice not found.');
    if (!['issued', 'partial'].includes(inv.status)) throw new Error('Payments can only be recorded against issued invoices.');
    const balance = inv.total_cents - inv.amount_paid_cents;
    if (amountCents > balance) throw new Error(`Payment exceeds the balance due (${fmt.money(balance)}).`);
    const date = fmt.dateOnly(receivedOn) || fmt.today();
    const info = await tx
      .prepare('INSERT INTO payments (invoice_id, customer_id, amount_cents, method, reference, received_on, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, inv.customer_id, amountCents, method, fmt.clean(reference, 200), date, memberId);
    const entryId = await accounting.post(tx, {
      date, memo: `Payment on ${inv.invoice_number} (${method}${reference ? ' ' + reference : ''})`, sourceType: 'payment', sourceId: info.lastInsertRowid, memberId,
      lines: [{ code: '1000', debit: amountCents }, { code: '1100', credit: amountCents }],
    });
    await tx.prepare('UPDATE payments SET journal_entry_id = ? WHERE id = ?').run(entryId, info.lastInsertRowid);
    const paid = inv.amount_paid_cents + amountCents;
    const status = paid >= inv.total_cents ? 'paid' : 'partial';
    await tx.prepare('UPDATE invoices SET amount_paid_cents = ?, status = ?, updated_at = now_text() WHERE id = ?').run(paid, status, id);
    if (status === 'paid' && inv.job_id) await jobs.setStatus(inv.job_id, 'paid', memberId, tx);
    return { paymentId: info.lastInsertRowid, status, balance: inv.total_cents - paid };
  });
}

async function voidInvoice(id, reason, memberId) {
  if (!fmt.clean(reason)) throw new Error('A reason is required to void an invoice.');
  return db.withTransaction(async (tx) => {
    const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) throw new Error('Invoice not found.');
    if (inv.status === 'void') throw new Error('Invoice is already void.');
    if (inv.amount_paid_cents > 0) throw new Error('This invoice has payments recorded. Refund/credit handling is not available yet, so it cannot be voided.');
    if (inv.journal_entry_id) await accounting.reverse(tx, inv.journal_entry_id, { memo: `Void ${inv.invoice_number}: ${reason}`, memberId });
    await tx.prepare("UPDATE invoices SET status = 'void', notes = COALESCE(notes, '') || ? , updated_at = now_text() WHERE id = ?").run(`\n[Voided: ${reason}]`, id);
    if (inv.job_id) {
      const job = await tx.prepare('SELECT status FROM jobs WHERE id = ?').get(inv.job_id);
      if (job && job.status === 'invoiced') await jobs.setStatus(inv.job_id, 'completed', memberId, tx);
    }
  });
}

// Accounts receivable aging as of a date, from open invoices.
async function aging(asOf = fmt.today()) {
  const rows = await db
    .prepare("SELECT i.*, c.name AS \"customerName\" FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('issued','partial') AND i.issue_date <= ? ORDER BY c.name, i.due_date")
    .all(asOf);
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const out = rows.map((r) => {
    const balance = r.total_cents - r.amount_paid_cents;
    const days = r.due_date ? Math.floor((fmt.parseTs(asOf + ' 00:00:00') - fmt.parseTs(r.due_date + ' 00:00:00')) / 86400000) : 0;
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
    buckets[bucket] += balance;
    return { ...r, balance, daysOverdue: Math.max(0, days), bucket };
  });
  return { asOf, rows: out, buckets, total: out.reduce((s, r) => s + r.balance, 0) };
}

module.exports = { KINDS, METHODS, get, details, list, createFromJob, createBlank, editDraft, addDraftLine, removeDraftLine, issue, recordPayment, voidInvoice, aging, recalc };
