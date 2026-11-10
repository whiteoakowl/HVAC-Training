// Vendors, purchase orders, receiving, vendor bills and bill payments.
//
// Accounting flow (accrual, three-way match):
//   receive stock on a PO  -> Dr 1200 Inventory        / Cr 2050 Goods Received Not Invoiced
//   enter the vendor bill  -> Dr 2050 (stock received) + Dr expense (non-stock lines) / Cr 2000 A/P
//   pay the bill           -> Dr 2000 A/P               / Cr 1000 Cash (or 2400 Credit Card)
// Bills without a PO post straight to the chosen expense accounts.
const db = require('../db');
const fmt = require('./format');
const accounting = require('./accounting');
const inventory = require('./inventory');

const PO_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'ordered', 'partial', 'received', 'cancelled'];
const PAY_METHODS = ['check', 'ach', 'card', 'cash', 'credit_card', 'other'];
const EPS = 1e-9;

// ---------------------------------------------------------------- vendors
async function listVendors({ activeOnly = false } = {}) {
  return db
    .prepare(`SELECT v.*, COALESCE((SELECT SUM(total_cents - amount_paid_cents) FROM vendor_bills b WHERE b.vendor_id = v.id AND b.status IN ('open','partial')), 0) AS "owed"
      FROM vendors v ${activeOnly ? 'WHERE v.active = 1' : ''} ORDER BY v.active DESC, v.name`)
    .all();
}

async function getVendor(id) {
  return db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
}

function vendorValues(d) {
  const name = fmt.clean(d.name, 200);
  if (!name) throw new Error('Vendor name is required.');
  const terms = parseInt(d.terms_days, 10);
  return [name, fmt.clean(d.contact_name, 200), fmt.clean(d.email, 200), fmt.clean(d.phone, 40), fmt.clean(d.address, 300), fmt.clean(d.account_number, 100), Number.isFinite(terms) && terms >= 0 ? terms : 30, fmt.clean(d.notes, 2000)];
}

async function saveVendor(id, d) {
  const v = vendorValues(d);
  const dup = await db.prepare('SELECT id FROM vendors WHERE LOWER(name) = LOWER(?) AND id <> ?').get(v[0], id || 0);
  if (dup) throw new Error('A vendor with that name already exists.');
  if (id) {
    await db.prepare('UPDATE vendors SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, account_number = ?, terms_days = ?, notes = ?, active = ? WHERE id = ?').run(...v, d.active === '0' ? 0 : 1, id);
    return id;
  }
  const info = await db.prepare('INSERT INTO vendors (name, contact_name, email, phone, address, account_number, terms_days, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...v);
  return info.lastInsertRowid;
}

// ---------------------------------------------------------------- purchase orders
async function getPO(id, tx = db) {
  const po = await tx
    .prepare(`SELECT po.*, v.name AS "vendorName", v.email AS "vendorEmail", v.phone AS "vendorPhone", v.address AS "vendorAddress", v.account_number, v.terms_days, l.name AS "locationName",
        cb.name AS "createdByName", ab.name AS "approvedByName"
      FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id JOIN inventory_locations l ON l.id = po.location_id LEFT JOIN members cb ON cb.id = po.created_by LEFT JOIN members ab ON ab.id = po.approved_by WHERE po.id = ?`)
    .get(id);
  if (!po) return null;
  po.lines = await tx.prepare('SELECT pl.*, i.sku, i.name AS "itemName", i.unit FROM purchase_order_lines pl LEFT JOIN inventory_items i ON i.id = pl.item_id WHERE pl.po_id = ? ORDER BY pl.id').all(id);
  po.bills = await tx.prepare('SELECT id, bill_number, total_cents, status FROM vendor_bills WHERE po_id = ? ORDER BY id').all(id);
  return po;
}

async function listPOs({ status = null, open = false } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('po.status = ?'); params.push(status); }
  if (open) where.push("po.status IN ('draft','pending_approval','approved','ordered','partial')");
  return db
    .prepare(`SELECT po.*, v.name AS "vendorName", l.name AS "locationName" FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id JOIN inventory_locations l ON l.id = po.location_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY po.id DESC LIMIT 500`)
    .all(...params);
}

async function recalcPO(tx, id) {
  const t = await tx.prepare('SELECT COALESCE(SUM(quantity * unit_cost_cents), 0) AS t FROM purchase_order_lines WHERE po_id = ?').get(id);
  await tx.prepare('UPDATE purchase_orders SET total_cents = ?, updated_at = now_text() WHERE id = ?').run(Math.round(Number(t.t)), id);
}

async function createPO({ vendorId, locationId, expectedOn, notes }, memberId, tx = null) {
  const body = async (t) => {
    if (!(await t.prepare('SELECT id FROM vendors WHERE id = ? AND active = 1').get(vendorId))) throw new Error('Choose an active vendor.');
    if (!(await t.prepare('SELECT id FROM inventory_locations WHERE id = ?').get(locationId))) throw new Error('Choose where the order will be delivered.');
    const info = await t.prepare('INSERT INTO purchase_orders (vendor_id, location_id, expected_on, notes, created_by) VALUES (?, ?, ?, ?, ?)').run(vendorId, locationId, fmt.dateOnly(expectedOn), fmt.clean(notes, 2000), memberId);
    const id = info.lastInsertRowid;
    await t.prepare('UPDATE purchase_orders SET po_number = ? WHERE id = ?').run(fmt.number('PO', id), id);
    return id;
  };
  return tx ? body(tx) : db.withTransaction(body);
}

async function requireDraftPO(tx, id) {
  const po = await tx.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
  if (!po) throw new Error('Purchase order not found.');
  if (!['draft', 'rejected'].includes(po.status)) throw new Error('Only draft purchase orders can be changed.');
  return po;
}

async function addPOLine(id, { itemId, description, quantity, unitCostCents }, tx = null) {
  const body = async (t) => {
    await requireDraftPO(t, id);
    const item = itemId ? await t.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId) : null;
    if (itemId && !item) throw new Error('Item not found.');
    const desc = fmt.clean(description, 300) || (item ? `${item.name} (${item.sku})` : null);
    if (!desc) throw new Error('Describe the item.');
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.');
    const cost = unitCostCents === null || unitCostCents === undefined ? (item ? item.unit_cost_cents : null) : unitCostCents;
    if (!Number.isInteger(cost) || cost < 0) throw new Error('Enter the unit cost.');
    await t.prepare('INSERT INTO purchase_order_lines (po_id, item_id, description, quantity, unit_cost_cents) VALUES (?, ?, ?, ?, ?)').run(id, item ? item.id : null, desc, qty, cost);
    await recalcPO(t, id);
  };
  return tx ? body(tx) : db.withTransaction(body);
}

async function removePOLine(id, lineId) {
  await db.withTransaction(async (tx) => {
    await requireDraftPO(tx, id);
    await tx.prepare('DELETE FROM purchase_order_lines WHERE id = ? AND po_id = ?').run(lineId, id);
    await recalcPO(tx, id);
  });
}

async function setPOStatus(id, to, memberId, { canApprove = false } = {}) {
  return db.withTransaction(async (tx) => {
    const po = await tx.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!po) throw new Error('Purchase order not found.');
    const lines = await tx.prepare('SELECT COUNT(*) AS c FROM purchase_order_lines WHERE po_id = ?').get(id);
    const allowed = {
      submit: [['draft', 'rejected'], 'pending_approval'],
      approve: [['pending_approval'], 'approved'],
      reject: [['pending_approval'], 'rejected'],
      order: [['approved'], 'ordered'],
      cancel: [['draft', 'pending_approval', 'approved', 'rejected', 'ordered'], 'cancelled'],
    }[to];
    if (!allowed) throw new Error('Invalid action.');
    if (!allowed[0].includes(po.status)) throw new Error(`A ${fmt.label(po.status).toLowerCase()} purchase order can't be ${to === 'order' ? 'marked ordered' : to + 'ed'}.`);
    if (to === 'submit' && !lines.c) throw new Error('Add at least one line first.');
    if (['approve', 'reject'].includes(to) && !canApprove) throw new Error('You need purchase-approval permission.');
    if (to === 'approve' && po.created_by === memberId) throw new Error("You can't approve your own purchase order.");
    if (to === 'cancel' && po.status === 'ordered') {
      const rec = await tx.prepare('SELECT COALESCE(SUM(received_qty), 0) AS r FROM purchase_order_lines WHERE po_id = ?').get(id);
      if (Number(rec.r) > 0) throw new Error('Items have already been received on this order.');
    }
    await tx.prepare('UPDATE purchase_orders SET status = ?, updated_at = now_text() WHERE id = ?').run(allowed[1], id);
    if (to === 'approve') await tx.prepare('UPDATE purchase_orders SET approved_by = ?, approved_at = now_text() WHERE id = ?').run(memberId, id);
    if (to === 'order') await tx.prepare('UPDATE purchase_orders SET ordered_at = now_text() WHERE id = ?').run(id);
    return { from: po.status, to: allowed[1] };
  });
}

// quantities: { lineId: qtyReceivedNow }
async function receivePO(id, quantities, memberId) {
  return db.withTransaction(async (tx) => {
    const po = await getPO(id, tx);
    if (!po) throw new Error('Purchase order not found.');
    if (!['ordered', 'partial', 'approved'].includes(po.status)) throw new Error('Only approved or ordered purchase orders can be received.');
    let any = false;
    for (const line of po.lines) {
      const q = Number(quantities[line.id] || 0);
      if (!q) continue;
      if (q < 0) throw new Error('Received quantities must be positive.');
      const remaining = Number(line.quantity) - Number(line.received_qty);
      if (q > remaining + EPS) throw new Error(`Only ${remaining} of "${line.description}" are still expected.`);
      any = true;
      let entryId = null;
      if (line.item_id) {
        await inventory.receiveTx(tx, { itemId: line.item_id, locationId: po.location_id, qty: q, unitCostCents: line.unit_cost_cents, fundingCode: '2050', reference: po.po_number, memberId });
        const je = await tx.prepare("SELECT id FROM journal_entries WHERE source_type = 'inventory_tx' ORDER BY id DESC LIMIT 1").get();
        entryId = je ? je.id : null;
      }
      await tx.prepare('UPDATE purchase_order_lines SET received_qty = received_qty + ? WHERE id = ?').run(q, line.id);
      await tx.prepare('INSERT INTO po_receipts (po_id, line_id, quantity, unit_cost_cents, journal_entry_id, member_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, line.id, q, line.unit_cost_cents, entryId, memberId);
    }
    if (!any) throw new Error('Enter the quantity received for at least one line.');
    const left = await tx.prepare('SELECT COUNT(*) AS c FROM purchase_order_lines WHERE po_id = ? AND received_qty < quantity - 0.000001').get(id);
    const status = left.c ? 'partial' : 'received';
    await tx.prepare('UPDATE purchase_orders SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
    return status;
  });
}

// Draft POs (one per preferred vendor) for warehouse items at/below minimum.
async function draftFromLowStock(memberId) {
  const wh = await inventory.warehouse();
  const low = await db
    .prepare(`SELECT s.item_id, s.quantity, s.min_quantity, i.preferred_vendor_id, i.unit_cost_cents, i.name FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id
      WHERE s.location_id = ? AND i.active = 1 AND s.min_quantity > 0 AND s.quantity <= s.min_quantity`)
    .all(wh.id);
  const onOrder = await db
    .prepare("SELECT pl.item_id, SUM(pl.quantity - pl.received_qty) AS q FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE po.status IN ('draft','pending_approval','approved','ordered','partial') AND pl.item_id IS NOT NULL GROUP BY pl.item_id")
    .all();
  const pending = Object.fromEntries(onOrder.map((r) => [r.item_id, Number(r.q)]));
  const byVendor = {};
  const skipped = [];
  for (const r of low) {
    const target = Number(r.min_quantity) * 2;
    const need = Math.ceil(target - Number(r.quantity) - (pending[r.item_id] || 0));
    if (need <= 0) continue;
    if (!r.preferred_vendor_id) { skipped.push(r.name); continue; }
    (byVendor[r.preferred_vendor_id] = byVendor[r.preferred_vendor_id] || []).push({ itemId: r.item_id, qty: need, cost: r.unit_cost_cents });
  }
  const created = [];
  for (const [vendorId, lines] of Object.entries(byVendor)) {
    const id = await db.withTransaction(async (tx) => {
      const poId = await createPO({ vendorId: parseInt(vendorId, 10), locationId: wh.id, notes: 'Restock - generated from low-stock alerts' }, memberId, tx);
      for (const l of lines) await addPOLine(poId, { itemId: l.itemId, quantity: l.qty, unitCostCents: l.cost }, tx);
      return poId;
    });
    created.push(id);
  }
  return { created, skipped };
}

// ---------------------------------------------------------------- vendor bills
async function getBill(id) {
  const b = await db
    .prepare('SELECT b.*, v.name AS "vendorName", po.po_number FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id LEFT JOIN purchase_orders po ON po.id = b.po_id WHERE b.id = ?')
    .get(id);
  if (!b) return null;
  b.lines = await db.prepare('SELECT bl.*, a.code, a.name AS "accountName" FROM vendor_bill_lines bl JOIN accounts a ON a.id = bl.account_id WHERE bl.bill_id = ? ORDER BY bl.id').all(id);
  b.payments = await db.prepare('SELECT bp.*, m.name AS "recordedByName" FROM bill_payments bp LEFT JOIN members m ON m.id = bp.recorded_by WHERE bp.bill_id = ? ORDER BY bp.id').all(id);
  b.balance = b.total_cents - b.amount_paid_cents;
  return b;
}

async function listBills({ status = null, vendorId = null } = {}) {
  const where = [];
  const params = [];
  if (status === 'open') where.push("b.status IN ('open','partial')");
  else if (status) { where.push('b.status = ?'); params.push(status); }
  if (vendorId) { where.push('b.vendor_id = ?'); params.push(vendorId); }
  return db
    .prepare(`SELECT b.*, v.name AS "vendorName", po.po_number FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id LEFT JOIN purchase_orders po ON po.id = b.po_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE WHEN b.status IN ('open','partial') THEN 0 ELSE 1 END, b.due_date, b.id DESC LIMIT 500`)
    .all(...params);
}

async function insertBill(tx, { vendor, poId, billNumber, billDate, dueDate, memo, attachment, lines, memberId }) {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (total <= 0) throw new Error('The bill total must be greater than zero.');
  if (billNumber) {
    const dup = await tx.prepare("SELECT id FROM vendor_bills WHERE vendor_id = ? AND bill_number = ? AND status <> 'void'").get(vendor.id, billNumber);
    if (dup) throw new Error(`Bill ${billNumber} from ${vendor.name} is already entered.`);
  }
  const date = fmt.dateOnly(billDate) || fmt.today();
  const due = fmt.dateOnly(dueDate) || fmt.addDays(date, vendor.terms_days || 30);
  const info = await tx
    .prepare('INSERT INTO vendor_bills (vendor_id, po_id, bill_number, bill_date, due_date, total_cents, memo, attachment, attachment_name, attachment_mime, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(vendor.id, poId, billNumber, date, due, total, memo, attachment ? attachment.buffer : null, attachment ? String(attachment.originalname).slice(0, 200) : null, attachment ? attachment.mimetype : null, memberId);
  const billId = info.lastInsertRowid;
  for (const l of lines) await tx.prepare('INSERT INTO vendor_bill_lines (bill_id, account_id, description, amount_cents, po_line_id, quantity) VALUES (?, ?, ?, ?, ?, ?)').run(billId, l.accountId, l.description, l.amount, l.poLineId || null, l.quantity || null);
  const byAccount = {};
  for (const l of lines) byAccount[l.accountId] = (byAccount[l.accountId] || 0) + l.amount;
  const entryId = await accounting.post(tx, {
    date, memo: `Vendor bill ${billNumber || '#' + billId} - ${vendor.name}`, sourceType: 'vendor_bill', sourceId: billId, memberId,
    lines: [...Object.entries(byAccount).map(([accountId, amt]) => ({ accountId: parseInt(accountId, 10), debit: amt })), { code: '2000', credit: total }],
  });
  await tx.prepare('UPDATE vendor_bills SET journal_entry_id = ? WHERE id = ?').run(entryId, billId);
  return billId;
}

// Manual bill: lines [{ accountId, description, amountCents }]
async function createBill({ vendorId, billNumber, billDate, dueDate, memo, lines, attachment }, memberId) {
  const vendor = await getVendor(vendorId);
  if (!vendor) throw new Error('Choose a vendor.');
  const valid = new Set((await accounting.listAccounts({ activeOnly: true })).filter((a) => ['expense', 'cogs', 'asset'].includes(a.type)).map((a) => a.id));
  const clean = lines.filter((l) => l.amountCents).map((l) => {
    if (!valid.has(l.accountId)) throw new Error('Bill lines must use an active expense, cost or asset account.');
    if (l.amountCents < 0) throw new Error('Amounts must be positive.');
    return { accountId: l.accountId, description: fmt.clean(l.description, 300), amount: l.amountCents };
  });
  if (!clean.length) throw new Error('Add at least one line with an amount.');
  return db.withTransaction((tx) => insertBill(tx, { vendor, poId: null, billNumber: fmt.clean(billNumber, 100), billDate, dueDate, memo: fmt.clean(memo, 1000), attachment, lines: clean, memberId }));
}

// Bill for everything received on a PO but not yet billed.
async function billPO(poId, { billNumber, billDate, dueDate, expenseAccountId, attachment }, memberId) {
  return db.withTransaction(async (tx) => {
    const po = await getPO(poId, tx);
    if (!po) throw new Error('Purchase order not found.');
    const vendor = await tx.prepare('SELECT * FROM vendors WHERE id = ?').get(po.vendor_id);
    const grni = await accounting.accountByCode('2050', tx);
    const fallback = expenseAccountId || (await accounting.accountByCode('6900', tx)).id;
    const lines = [];
    for (const l of po.lines) {
      const qty = Number(l.received_qty) - Number(l.billed_qty);
      if (qty <= EPS) continue;
      lines.push({ accountId: l.item_id ? grni.id : fallback, description: l.description, amount: Math.round(qty * l.unit_cost_cents), poLineId: l.id, quantity: qty });
      await tx.prepare('UPDATE purchase_order_lines SET billed_qty = billed_qty + ? WHERE id = ?').run(qty, l.id);
    }
    if (!lines.length) throw new Error('Nothing has been received on this order that is not already billed.');
    return insertBill(tx, { vendor, poId, billNumber: fmt.clean(billNumber, 100), billDate, dueDate, memo: `Per ${po.po_number}`, attachment, lines, memberId });
  });
}

async function payBill(billId, { amountCents, method, reference, paidOn }, memberId) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Enter the amount paid.');
  if (!PAY_METHODS.includes(method)) throw new Error('Choose a payment method.');
  return db.withTransaction(async (tx) => {
    const b = await tx.prepare('SELECT b.*, v.name AS "vendorName" FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ?').get(billId);
    if (!b || !['open', 'partial'].includes(b.status)) throw new Error('Only open bills can be paid.');
    const bal = b.total_cents - b.amount_paid_cents;
    if (amountCents > bal) throw new Error(`Payment exceeds the balance (${fmt.money(bal)}).`);
    const date = fmt.dateOnly(paidOn) || fmt.today();
    const info = await tx.prepare('INSERT INTO bill_payments (bill_id, amount_cents, method, reference, paid_on, recorded_by) VALUES (?, ?, ?, ?, ?, ?)').run(billId, amountCents, method, fmt.clean(reference, 100), date, memberId);
    const entryId = await accounting.post(tx, {
      date, memo: `Paid ${b.vendorName} bill ${b.bill_number || '#' + b.id} (${fmt.label(method)}${reference ? ' ' + reference : ''})`, sourceType: 'bill_payment', sourceId: info.lastInsertRowid, memberId,
      lines: [{ code: '2000', debit: amountCents }, { code: method === 'credit_card' ? '2400' : '1000', credit: amountCents }],
    });
    await tx.prepare('UPDATE bill_payments SET journal_entry_id = ? WHERE id = ?').run(entryId, info.lastInsertRowid);
    const paid = b.amount_paid_cents + amountCents;
    await tx.prepare('UPDATE vendor_bills SET amount_paid_cents = ?, status = ? WHERE id = ?').run(paid, paid >= b.total_cents ? 'paid' : 'partial', billId);
  });
}

async function voidBill(billId, reason, memberId) {
  if (!fmt.clean(reason)) throw new Error('A reason is required.');
  return db.withTransaction(async (tx) => {
    const b = await tx.prepare('SELECT * FROM vendor_bills WHERE id = ?').get(billId);
    if (!b || b.status === 'void') throw new Error('Bill not found or already void.');
    if (b.amount_paid_cents > 0) throw new Error('This bill has payments; it cannot be voided.');
    await accounting.reverse(tx, b.journal_entry_id, { memo: `Void vendor bill ${b.bill_number || '#' + b.id}: ${reason}`, memberId });
    const lines = await tx.prepare('SELECT * FROM vendor_bill_lines WHERE bill_id = ? AND po_line_id IS NOT NULL').all(billId);
    for (const l of lines) await tx.prepare('UPDATE purchase_order_lines SET billed_qty = billed_qty - ? WHERE id = ?').run(Number(l.quantity), l.po_line_id);
    await tx.prepare("UPDATE vendor_bills SET status = 'void', memo = COALESCE(memo, '') || ? WHERE id = ?").run(` [Void: ${reason}]`, billId);
  });
}

async function apAging(asOf = fmt.today()) {
  const rows = await db.prepare("SELECT b.*, v.name AS \"vendorName\" FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.status IN ('open','partial') AND b.bill_date <= ? ORDER BY b.due_date").all(asOf);
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

module.exports = {
  PO_STATUSES, PAY_METHODS, listVendors, getVendor, saveVendor, getPO, listPOs, createPO, addPOLine, removePOLine, setPOStatus, receivePO, draftFromLowStock,
  getBill, listBills, createBill, billPO, payBill, voidBill, apAging,
};
