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
  inv.credits = await db.prepare('SELECT cn.*, m.name AS "createdByName" FROM credit_notes cn LEFT JOIN members m ON m.id = cn.created_by WHERE cn.invoice_id = ? ORDER BY cn.id').all(id);
  inv.refunds = await db.prepare('SELECT * FROM refunds WHERE invoice_id = ? ORDER BY id').all(id);
  inv.balance = inv.total_cents - inv.amount_paid_cents - inv.credited_cents;
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

// accountCode overrides the revenue account for the line (e.g. '4200'
// maintenance agreements, '2200' customer deposits).
async function addLine(tx, invoiceId, { kind, description, quantity, unitPriceCents, taxable = true, accountCode = null }) {
  const desc = fmt.clean(description, 500);
  if (!desc) throw new Error('Line description is required.');
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');
  if (!Number.isInteger(unitPriceCents)) throw new Error('Enter a unit price.');
  if (unitPriceCents < 0 && !accountCode) throw new Error('Use the invoice discount or a credit instead of a negative line.');
  const pos = await tx.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM invoice_lines WHERE invoice_id = ?').get(invoiceId);
  await tx
    .prepare('INSERT INTO invoice_lines (invoice_id, kind, description, quantity, unit_price_cents, amount_cents, taxable, position, account_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(invoiceId, KINDS.includes(kind) ? kind : 'other', desc, qty, unitPriceCents, Math.round(qty * unitPriceCents), taxable ? 1 : 0, pos.p, accountCode);
}

async function createDraft(tx, { customerId, jobId = null, memberId, agreementId = null, estimateId = null, taxRateBp = null }) {
  const terms = await settings.getInt('invoice_terms_days', 30);
  const taxBp = taxRateBp === null ? await settings.getInt('default_tax_rate_bp', 0) : taxRateBp;
  const info = await tx
    .prepare("INSERT INTO invoices (customer_id, job_id, agreement_id, estimate_id, status, tax_rate_bp, terms, notes, created_by, public_token) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
    .run(customerId, jobId, agreementId, estimateId, taxBp, `Net ${terms}`, await settings.get('invoice_footer', null), memberId, require('crypto').randomBytes(24).toString('hex'));
  const id = info.lastInsertRowid;
  await tx.prepare('UPDATE invoices SET invoice_number = ? WHERE id = ?').run(fmt.number('INV', id), id);
  return id;
}

// Draft invoice from a job. Price source, in order:
//   1. the approved estimate the job came from (its lines),
//   2. the job's quoted price,
//   3. actual labor (clocked time, or estimated hours) at the labor rate
//      plus each material at its selling price and any permits.
// Approved change orders are added, and deposits already invoiced on
// the estimate are deducted. Always a draft for a person to review.
async function createFromJob(jobId, memberId) {
  const existing = await db.prepare("SELECT id FROM invoices WHERE job_id = ? AND status <> 'void' AND estimate_id IS NULL").get(jobId);
  if (existing) return { id: existing.id, created: false };
  const job = await jobs.get(jobId);
  if (!job) throw new Error('Job not found.');
  const labor = await jobs.laborFor(jobId);
  const rate = await settings.getInt('labor_rate_cents', 0);
  const materials = await db.prepare('SELECT jm.*, i.name, i.unit FROM job_materials jm JOIN inventory_items i ON i.id = jm.item_id WHERE jm.job_id = ? ORDER BY jm.id').all(jobId);
  const costs = await db.prepare('SELECT * FROM job_costs WHERE job_id = ? ORDER BY id').all(jobId);
  const estimate = job.estimate_id ? await db.prepare("SELECT * FROM estimates WHERE id = ? AND status IN ('approved','converted')").get(job.estimate_id) : null;
  const estLines = estimate ? await db.prepare('SELECT * FROM estimate_lines WHERE estimate_id = ? ORDER BY position, id').all(estimate.id) : [];
  const changeOrders = await db.prepare("SELECT * FROM change_orders WHERE job_id = ? AND status = 'approved' AND invoiced = 0 ORDER BY number").all(jobId);
  const deposits = estimate
    ? await db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents), 0) AS d FROM invoices WHERE estimate_id = ? AND job_id IS NULL AND status IN ('issued','partial','paid')").get(estimate.id)
    : { d: 0 };
  // Maintenance-agreement visits: the visit itself is prepaid; only
  // parts and approved extras are billable.
  const covered = Boolean(job.agreement_visit_id);
  if (covered && !materials.length && !changeOrders.length) return { id: null, created: false, covered: true };
  const id = await db.withTransaction(async (tx) => {
    const invId = await createDraft(tx, { customerId: job.customer_id, jobId, memberId, taxRateBp: estimate ? estimate.tax_rate_bp : null });
    if (covered) {
      for (const m of materials) await addLine(tx, invId, { kind: 'material', description: `${m.name}`, quantity: Number(m.quantity), unitPriceCents: m.unit_price_cents });
    } else if (estimate) {
      for (const l of estLines) {
        const kind = l.kind === 'permit' ? 'fee' : l.kind;
        await addLine(tx, invId, { kind, description: l.description, quantity: Number(l.quantity), unitPriceCents: l.unit_price_cents, taxable: Boolean(l.taxable) });
      }
      if (estimate.discount_cents) await tx.prepare('UPDATE invoices SET discount_cents = ? WHERE id = ?').run(estimate.discount_cents, invId);
    } else if (job.quoted_price_cents) {
      await addLine(tx, invId, { kind: 'labor', description: `${job.title} (as quoted)`, quantity: 1, unitPriceCents: job.quoted_price_cents });
    } else {
      const hrs = labor.minutes ? Math.round((labor.minutes / 60) * 100) / 100 : job.estimated_hours || 0;
      if (hrs > 0) await addLine(tx, invId, { kind: 'labor', description: `Labor - ${job.title}${labor.minutes ? '' : ' (estimated hours)'}`, quantity: hrs, unitPriceCents: rate });
      for (const m of materials) await addLine(tx, invId, { kind: 'material', description: `${m.name}`, quantity: Number(m.quantity), unitPriceCents: m.unit_price_cents });
      for (const c of costs.filter((x) => x.category === 'permit')) await addLine(tx, invId, { kind: 'fee', description: `Permit: ${c.description}`, quantity: 1, unitPriceCents: c.amount_cents, taxable: false });
    }
    for (const co of changeOrders) {
      await addLine(tx, invId, { kind: 'other', description: `Change order #${co.number}: ${co.description}`, quantity: 1, unitPriceCents: co.amount_cents });
      await tx.prepare('UPDATE change_orders SET invoiced = 1 WHERE id = ?').run(co.id);
    }
    if (Number(deposits.d) > 0) {
      await addLine(tx, invId, { kind: 'other', description: `Less deposit received (estimate ${estimate.estimate_number})`, quantity: 1, unitPriceCents: -Number(deposits.d), taxable: false, accountCode: '2200' });
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
    for (const l of lines) {
      const code = l.account_code || REVENUE_ACCOUNT[l.kind];
      revenue[code] = (revenue[code] || 0) + l.amount_cents;
    }
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

// Status from the three running totals: payments, credits and total.
function statusFor(inv) {
  const due = inv.total_cents - inv.amount_paid_cents - inv.credited_cents;
  if (due <= 0) return 'paid';
  return inv.amount_paid_cents > 0 || inv.credited_cents > 0 ? 'partial' : 'issued';
}

async function syncStatus(tx, id, memberId) {
  const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  const status = statusFor(inv);
  await tx.prepare('UPDATE invoices SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
  if (inv.job_id) {
    const job = await tx.prepare('SELECT status FROM jobs WHERE id = ?').get(inv.job_id);
    if (job && status === 'paid' && job.status === 'invoiced') await jobs.setStatus(inv.job_id, 'paid', memberId, tx);
    if (job && status !== 'paid' && job.status === 'paid') await jobs.setStatus(inv.job_id, 'invoiced', memberId, tx);
  }
  return { status, balance: inv.total_cents - inv.amount_paid_cents - inv.credited_cents };
}

async function recordPayment(id, { amountCents, method, reference, receivedOn }, memberId) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Payment amount must be greater than zero.');
  if (!METHODS.includes(method)) throw new Error('Choose a payment method.');
  return db.withTransaction(async (tx) => {
    const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) throw new Error('Invoice not found.');
    if (!['issued', 'partial'].includes(inv.status)) throw new Error('Payments can only be recorded against issued invoices.');
    const balance = inv.total_cents - inv.amount_paid_cents - inv.credited_cents;
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
    await tx.prepare('UPDATE invoices SET amount_paid_cents = amount_paid_cents + ? WHERE id = ?').run(amountCents, id);
    const r = await syncStatus(tx, id, memberId);
    return { paymentId: info.lastInsertRowid, ...r };
  });
}

// Credit memo: reduces what the customer owes (goodwill, billing error,
// warranty). Posts Dr 4910 Customer Credits / Cr 1100 A/R. Cannot exceed
// the unpaid balance - to give money back, credit then refund.
async function applyCredit(id, { amountCents, reason }, memberId) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Credit amount must be greater than zero.');
  if (!fmt.clean(reason)) throw new Error('A reason is required for a credit.');
  return db.withTransaction(async (tx) => {
    const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv || !['issued', 'partial', 'paid'].includes(inv.status)) throw new Error('Credits apply to issued invoices only.');
    const maxCredit = inv.total_cents - inv.credited_cents;
    if (amountCents > maxCredit) throw new Error(`Credit cannot exceed ${fmt.money(maxCredit)}.`);
    const info = await tx.prepare('INSERT INTO credit_notes (invoice_id, amount_cents, reason, created_by) VALUES (?, ?, ?, ?)').run(id, amountCents, fmt.clean(reason, 500), memberId);
    const entryId = await accounting.post(tx, {
      memo: `Credit on ${inv.invoice_number}: ${fmt.clean(reason, 200)}`, sourceType: 'credit_note', sourceId: info.lastInsertRowid, memberId,
      lines: [{ code: '4910', debit: amountCents }, { code: '1100', credit: amountCents }],
    });
    await tx.prepare('UPDATE credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, info.lastInsertRowid);
    await tx.prepare('UPDATE invoices SET credited_cents = credited_cents + ? WHERE id = ?').run(amountCents, id);
    return syncStatus(tx, id, memberId);
  });
}

// Refund money already received. Only what was overpaid (payments +
// credits beyond the total) or, with a full reversal, any payment can be
// refunded; the refund re-opens the receivable it came from.
// Posts Dr 1100 A/R / Cr 1000 Cash.
async function refund(id, { amountCents, method, reference, reason, refundedOn }, memberId) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Refund amount must be greater than zero.');
  if (!METHODS.includes(method)) throw new Error('Choose how the refund was paid.');
  if (!fmt.clean(reason)) throw new Error('A reason is required for a refund.');
  return db.withTransaction(async (tx) => {
    const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv || !['issued', 'partial', 'paid'].includes(inv.status)) throw new Error('Refunds apply to issued invoices only.');
    if (amountCents > inv.amount_paid_cents) throw new Error(`Refund cannot exceed payments received (${fmt.money(inv.amount_paid_cents)}).`);
    const date = fmt.dateOnly(refundedOn) || fmt.today();
    const info = await tx
      .prepare('INSERT INTO refunds (invoice_id, amount_cents, method, reference, reason, refunded_on, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, amountCents, method, fmt.clean(reference, 200), fmt.clean(reason, 500), date, memberId);
    const entryId = await accounting.post(tx, {
      date, memo: `Refund on ${inv.invoice_number}: ${fmt.clean(reason, 200)}`, sourceType: 'refund', sourceId: info.lastInsertRowid, memberId,
      lines: [{ code: '1100', debit: amountCents }, { code: '1000', credit: amountCents }],
    });
    await tx.prepare('UPDATE refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, info.lastInsertRowid);
    await tx.prepare('UPDATE invoices SET amount_paid_cents = amount_paid_cents - ? WHERE id = ?').run(amountCents, id);
    return syncStatus(tx, id, memberId);
  });
}

async function voidInvoice(id, reason, memberId) {
  if (!fmt.clean(reason)) throw new Error('A reason is required to void an invoice.');
  return db.withTransaction(async (tx) => {
    const inv = await tx.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) throw new Error('Invoice not found.');
    if (inv.status === 'void') throw new Error('Invoice is already void.');
    if (inv.amount_paid_cents > 0) throw new Error('This invoice has payments recorded. Refund the payments first, then void it (or issue a credit).');
    if (inv.credited_cents > 0) throw new Error('This invoice has credits applied; credit the remaining balance instead of voiding.');
    if (inv.journal_entry_id) await accounting.reverse(tx, inv.journal_entry_id, { memo: `Void ${inv.invoice_number}: ${reason}`, memberId });
    await tx.prepare("UPDATE invoices SET status = 'void', notes = COALESCE(notes, '') || ? , updated_at = now_text() WHERE id = ?").run(`\n[Voided: ${reason}]`, id);
    await tx.prepare('UPDATE change_orders SET invoiced = 0 WHERE job_id = ? AND invoiced = 1').run(inv.job_id || 0);
    if (inv.job_id) {
      const job = await tx.prepare('SELECT status FROM jobs WHERE id = ?').get(inv.job_id);
      if (job && ['invoiced', 'paid'].includes(job.status)) await jobs.setStatus(inv.job_id, 'completed', memberId, tx);
    }
  });
}

// Deposit invoice for an approved estimate. Credited to 2200 Customer
// Deposits (a liability) and deducted from the final job invoice.
async function createDeposit(estimateId, memberId) {
  const est = await db.prepare('SELECT * FROM estimates WHERE id = ?').get(estimateId);
  if (!est) throw new Error('Estimate not found.');
  if (!['approved', 'converted'].includes(est.status)) throw new Error('The estimate must be approved first.');
  if (!(est.deposit_cents > 0)) throw new Error('This estimate has no deposit amount.');
  const existing = await db.prepare("SELECT id FROM invoices WHERE estimate_id = ? AND job_id IS NULL AND status <> 'void'").get(estimateId);
  if (existing) return { id: existing.id, created: false };
  const id = await db.withTransaction(async (tx) => {
    const invId = await createDraft(tx, { customerId: est.customer_id, estimateId, memberId, taxRateBp: 0 });
    await addLine(tx, invId, { kind: 'other', description: `Deposit for estimate ${est.estimate_number}: ${est.title}`, quantity: 1, unitPriceCents: est.deposit_cents, taxable: false, accountCode: '2200' });
    await recalc(tx, invId);
    return invId;
  });
  return { id, created: true };
}

// Draft invoice for a maintenance agreement term (revenue 4200).
async function createForAgreement(agreementId, memberId) {
  const ag = await db.prepare('SELECT * FROM maintenance_agreements WHERE id = ?').get(agreementId);
  if (!ag) throw new Error('Agreement not found.');
  if (!(ag.price_cents > 0)) throw new Error('This agreement has no price.');
  const existing = await db.prepare("SELECT id FROM invoices WHERE agreement_id = ? AND status <> 'void'").get(agreementId);
  if (existing) return { id: existing.id, created: false };
  const id = await db.withTransaction(async (tx) => {
    const invId = await createDraft(tx, { customerId: ag.customer_id, agreementId, memberId });
    await addLine(tx, invId, { kind: 'fee', description: `${ag.name} (${ag.agreement_number}) ${ag.start_date} to ${ag.end_date}`, quantity: 1, unitPriceCents: ag.price_cents, accountCode: '4200' });
    await recalc(tx, invId);
    return invId;
  });
  return { id, created: true };
}

async function byToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const row = await db.prepare('SELECT id FROM invoices WHERE public_token = ?').get(token);
  return row ? details(row.id) : null;
}

// Accounts receivable aging as of a date, from open invoices.
async function aging(asOf = fmt.today()) {
  const rows = await db
    .prepare("SELECT i.*, c.name AS \"customerName\" FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('issued','partial') AND i.issue_date <= ? ORDER BY c.name, i.due_date")
    .all(asOf);
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const out = rows.map((r) => {
    const balance = r.total_cents - r.amount_paid_cents - r.credited_cents;
    const days = r.due_date ? Math.floor((fmt.parseTs(asOf + ' 00:00:00') - fmt.parseTs(r.due_date + ' 00:00:00')) / 86400000) : 0;
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
    buckets[bucket] += balance;
    return { ...r, balance, daysOverdue: Math.max(0, days), bucket };
  });
  return { asOf, rows: out, buckets, total: out.reduce((s, r) => s + r.balance, 0) };
}

module.exports = {
  KINDS, METHODS, get, details, list, createFromJob, createBlank, createDeposit, createForAgreement, editDraft, addDraftLine, removeDraftLine,
  issue, recordPayment, applyCredit, refund, voidInvoice, aging, recalc, byToken, statusFor,
};
