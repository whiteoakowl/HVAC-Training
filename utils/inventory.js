// Inventory: items, warehouse + truck locations, per-location stock, and
// an append-only transaction history. Quantities only ever change
// through move(), which writes the transaction row in the same database
// transaction, and refuses to go negative unless explicitly allowed.
//
// Costing is moving weighted average across all locations: receiving
// updates inventory_items.unit_cost_cents, and usage/adjustments are
// valued at that average. The matching ledger postings (1200 Inventory,
// 5000 COGS, 5100 Shrinkage) are made here too.
const db = require('../db');
const fmt = require('./format');
const accounting = require('./accounting');

const EPS = 1e-9;

async function warehouse(tx = db) {
  return tx.prepare("SELECT * FROM inventory_locations WHERE kind = 'warehouse' ORDER BY id LIMIT 1").get();
}

async function listLocations() {
  return db
    .prepare(`SELECT l.*, t.assigned_member_id, m.name AS "assignedName" FROM inventory_locations l LEFT JOIN trucks t ON t.id = l.truck_id LEFT JOIN members m ON m.id = t.assigned_member_id WHERE l.active = 1 ORDER BY CASE WHEN l.kind = 'warehouse' THEN 0 ELSE 1 END, l.name`)
    .all();
}

async function getLocation(id, tx = db) {
  return tx.prepare('SELECT * FROM inventory_locations WHERE id = ?').get(id);
}

async function truckLocation(truckId, tx = db) {
  return tx.prepare('SELECT * FROM inventory_locations WHERE truck_id = ?').get(truckId);
}

async function getItem(id, tx = db) {
  return tx.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
}

async function listItems({ q = null, category = null, includeInactive = false } = {}) {
  const where = [];
  const params = [];
  if (!includeInactive) where.push('i.active = 1');
  if (q) {
    where.push('(LOWER(i.name) LIKE ? OR LOWER(i.sku) LIKE ? OR LOWER(COALESCE(i.barcode, \'\')) LIKE ? OR LOWER(COALESCE(i.manufacturer, \'\')) LIKE ?)');
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  if (category) { where.push('i.category = ?'); params.push(category); }
  return db
    .prepare(`SELECT i.*, COALESCE((SELECT SUM(quantity) FROM inventory_stock s WHERE s.item_id = i.id), 0) AS "totalQty",
        COALESCE((SELECT SUM(s.quantity) FROM inventory_stock s JOIN inventory_locations l ON l.id = s.location_id WHERE s.item_id = i.id AND l.kind = 'warehouse'), 0) AS "warehouseQty"
      FROM inventory_items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.name`)
    .all(...params);
}

async function categories() {
  return (await db.prepare("SELECT DISTINCT category FROM inventory_items WHERE category IS NOT NULL AND category <> '' ORDER BY category").all()).map((r) => r.category);
}

async function stockAt(locationId) {
  return db
    .prepare(`SELECT s.*, i.sku, i.name, i.unit, i.unit_cost_cents, i.price_cents, i.category FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id WHERE s.location_id = ? AND (s.quantity <> 0 OR s.min_quantity > 0) ORDER BY i.name`)
    .all(locationId);
}

async function stockForItem(itemId) {
  return db
    .prepare('SELECT s.*, l.name AS "locationName", l.kind FROM inventory_stock s JOIN inventory_locations l ON l.id = s.location_id WHERE s.item_id = ? ORDER BY l.kind DESC, l.name')
    .all(itemId);
}

async function quantity(tx, itemId, locationId) {
  const row = await tx.prepare('SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(itemId, locationId);
  return row ? Number(row.quantity) : 0;
}

async function setMin(itemId, locationId, minQty, bin = null) {
  await db
    .prepare('INSERT INTO inventory_stock (item_id, location_id, quantity, min_quantity, bin) VALUES (?, ?, 0, ?, ?) ON CONFLICT (item_id, location_id) DO UPDATE SET min_quantity = excluded.min_quantity, bin = excluded.bin')
    .run(itemId, locationId, minQty, bin);
}

// The single write path for stock levels.
async function move(tx, { itemId, locationId, change, kind, unitCostCents = 0, jobId = null, relatedLocationId = null, note = null, memberId = null, allowNegative = false }) {
  if (!Number.isFinite(change) || Math.abs(change) < EPS) throw new Error('Quantity must be a non-zero number.');
  const current = await quantity(tx, itemId, locationId);
  const next = Math.round((current + change) * 1000) / 1000;
  if (next < -EPS && !allowNegative) {
    const item = await getItem(itemId, tx);
    const loc = await getLocation(locationId, tx);
    throw new Error(`Not enough ${item ? item.name : 'stock'} at ${loc ? loc.name : 'that location'}: ${current} on hand, ${-change} needed.`);
  }
  await tx
    .prepare('INSERT INTO inventory_stock (item_id, location_id, quantity) VALUES (?, ?, ?) ON CONFLICT (item_id, location_id) DO UPDATE SET quantity = excluded.quantity')
    .run(itemId, locationId, next);
  const info = await tx
    .prepare('INSERT INTO inventory_transactions (item_id, location_id, quantity_change, kind, unit_cost_cents, job_id, related_location_id, note, member_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(itemId, locationId, change, kind, unitCostCents, jobId, relatedLocationId, note, memberId);
  return { transactionId: info.lastInsertRowid, before: current, after: next };
}

async function totalQty(tx, itemId) {
  const row = await tx.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE item_id = ?').get(itemId);
  return Number(row.q);
}

// Receive stock (purchase). fundingCode: '1000' paid now, '2000' on account.
async function receive({ itemId, locationId, qty, unitCostCents, fundingCode = '2000', reference = null, memberId }) {
  if (!(qty > 0)) throw new Error('Received quantity must be greater than zero.');
  if (!(unitCostCents >= 0)) throw new Error('Enter the unit cost.');
  if (!['1000', '2000'].includes(fundingCode)) throw new Error('Choose how the purchase was paid.');
  return db.withTransaction(async (tx) => {
    const item = await getItem(itemId, tx);
    if (!item) throw new Error('Item not found.');
    const onHand = Math.max(0, await totalQty(tx, itemId));
    const avg = onHand + qty > 0 ? Math.round((onHand * item.unit_cost_cents + qty * unitCostCents) / (onHand + qty)) : unitCostCents;
    await tx.prepare('UPDATE inventory_items SET unit_cost_cents = ? WHERE id = ?').run(avg, itemId);
    const r = await move(tx, { itemId, locationId, change: qty, kind: 'receive', unitCostCents, note: reference, memberId });
    const total = Math.round(qty * unitCostCents);
    if (total > 0) {
      await accounting.post(tx, {
        memo: `Inventory received: ${qty} x ${item.name}${reference ? ` (${reference})` : ''}`,
        sourceType: 'inventory_tx', sourceId: r.transactionId, memberId,
        lines: [{ code: '1200', debit: total }, { code: fundingCode, credit: total }],
      });
    }
    return r;
  });
}

async function transfer({ itemId, fromId, toId, qty, note = null, memberId }) {
  if (!(qty > 0)) throw new Error('Transfer quantity must be greater than zero.');
  if (String(fromId) === String(toId)) throw new Error('Choose two different locations.');
  return db.withTransaction(async (tx) => {
    const item = await getItem(itemId, tx);
    if (!item) throw new Error('Item not found.');
    if (!(await getLocation(fromId, tx)) || !(await getLocation(toId, tx))) throw new Error('Location not found.');
    await move(tx, { itemId, locationId: fromId, change: -qty, kind: 'transfer_out', unitCostCents: item.unit_cost_cents, relatedLocationId: toId, note, memberId });
    await move(tx, { itemId, locationId: toId, change: qty, kind: 'transfer_in', unitCostCents: item.unit_cost_cents, relatedLocationId: fromId, note, memberId });
  });
}

// Set counted quantity (audit) - posts the value difference to shrinkage.
async function adjust({ itemId, locationId, countedQty, reason, memberId, kind = 'audit' }) {
  if (!(countedQty >= 0)) throw new Error('Counted quantity must be zero or more.');
  if (!reason) throw new Error('A reason is required for inventory adjustments.');
  return db.withTransaction(async (tx) => {
    const item = await getItem(itemId, tx);
    if (!item) throw new Error('Item not found.');
    const current = await quantity(tx, itemId, locationId);
    const change = Math.round((countedQty - current) * 1000) / 1000;
    if (Math.abs(change) < EPS) return { change: 0 };
    const r = await move(tx, { itemId, locationId, change, kind, unitCostCents: item.unit_cost_cents, note: reason, memberId });
    const value = Math.round(Math.abs(change) * item.unit_cost_cents);
    if (value > 0) {
      await accounting.post(tx, {
        memo: `Inventory ${kind === 'audit' ? 'count' : 'adjustment'}: ${item.name} ${change > 0 ? '+' : ''}${change} (${reason})`,
        sourceType: 'inventory_tx', sourceId: r.transactionId, memberId,
        lines: change < 0 ? [{ code: '5100', debit: value }, { code: '1200', credit: value }] : [{ code: '1200', debit: value }, { code: '5100', credit: value }],
      });
    }
    return { change };
  });
}

// Deducts material from a location for a job and records it on the job.
// Must be called inside a transaction (tx).
async function useOnJob(tx, { jobId, itemId, locationId, qty, memberId, allowNegative = false }) {
  if (!(qty > 0)) throw new Error('Quantity used must be greater than zero.');
  const item = await getItem(itemId, tx);
  if (!item || !item.active) throw new Error('Item not found.');
  const job = await tx.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(jobId);
  const r = await move(tx, { itemId, locationId, change: -qty, kind: 'job_use', unitCostCents: item.unit_cost_cents, jobId, memberId, allowNegative, note: job ? job.job_number : null });
  const info = await tx
    .prepare('INSERT INTO job_materials (job_id, item_id, location_id, quantity, unit_cost_cents, unit_price_cents, transaction_id, member_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(jobId, itemId, locationId, qty, item.unit_cost_cents, item.price_cents, r.transactionId, memberId);
  const cost = Math.round(qty * item.unit_cost_cents);
  if (cost > 0) {
    await accounting.post(tx, {
      memo: `Materials used on ${job ? job.job_number : 'job'}: ${qty} x ${item.name}`,
      sourceType: 'job_material', sourceId: info.lastInsertRowid, memberId,
      lines: [{ code: '5000', debit: cost }, { code: '1200', credit: cost }],
    });
  }
  return { materialId: info.lastInsertRowid, after: r.after };
}

// Undo a material line (wrong item / returned to the truck).
async function returnFromJob(tx, { materialId, memberId }) {
  const m = await tx.prepare('SELECT jm.*, i.name FROM job_materials jm JOIN inventory_items i ON i.id = jm.item_id WHERE jm.id = ?').get(materialId);
  if (!m) throw new Error('Material line not found.');
  await move(tx, { itemId: m.item_id, locationId: m.location_id, change: Number(m.quantity), kind: 'job_return', unitCostCents: m.unit_cost_cents, jobId: m.job_id, memberId, note: 'Returned from job' });
  const cost = Math.round(Number(m.quantity) * m.unit_cost_cents);
  if (cost > 0) {
    await accounting.post(tx, {
      memo: `Materials returned from job: ${m.quantity} x ${m.name}`,
      sourceType: 'job_material', sourceId: m.id, memberId,
      lines: [{ code: '1200', debit: cost }, { code: '5000', credit: cost }],
    });
  }
  await tx.prepare('DELETE FROM job_materials WHERE id = ?').run(materialId);
  return m;
}

async function lowStock() {
  return db
    .prepare(`SELECT s.*, i.sku, i.name, i.unit, l.name AS "locationName", l.kind FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id JOIN inventory_locations l ON l.id = s.location_id
      WHERE i.active = 1 AND l.active = 1 AND s.min_quantity > 0 AND s.quantity <= s.min_quantity ORDER BY l.kind DESC, l.name, i.name`)
    .all();
}

async function valueByLocation() {
  const rows = await db
    .prepare(`SELECT l.id, l.name, l.kind, COALESCE(SUM(s.quantity * i.unit_cost_cents), 0) AS value FROM inventory_locations l LEFT JOIN inventory_stock s ON s.location_id = l.id LEFT JOIN inventory_items i ON i.id = s.item_id WHERE l.active = 1 GROUP BY l.id, l.name, l.kind ORDER BY l.kind DESC, l.name`)
    .all();
  return rows.map((r) => ({ ...r, value: Math.round(Number(r.value)) }));
}

async function transactions({ itemId = null, locationId = null, jobId = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (itemId) { where.push('t.item_id = ?'); params.push(itemId); }
  if (locationId) { where.push('t.location_id = ?'); params.push(locationId); }
  if (jobId) { where.push('t.job_id = ?'); params.push(jobId); }
  const max = Math.min(parseInt(limit, 10) || 200, 2000);
  return db
    .prepare(`SELECT t.*, i.name AS "itemName", i.sku, l.name AS "locationName", m.name AS "memberName", j.job_number FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id JOIN inventory_locations l ON l.id = t.location_id LEFT JOIN members m ON m.id = t.member_id LEFT JOIN jobs j ON j.id = t.job_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.id DESC LIMIT ${max}`)
    .all(...params);
}

module.exports = {
  warehouse, listLocations, getLocation, truckLocation, getItem, listItems, categories, stockAt, stockForItem, quantity, setMin,
  move, receive, transfer, adjust, useOnJob, returnFromJob, lowStock, valueByLocation, transactions, fmt,
};
