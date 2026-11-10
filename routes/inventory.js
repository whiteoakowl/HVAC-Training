// Inventory (warehouse + truck stock), trucks, and parts-request approvals.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const inventory = require('../utils/inventory');
const notifications = require('../utils/notifications');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

router.use(['/inventory', '/trucks'], requireAuth);

const ITEM_FIELDS = ['sku', 'name', 'description', 'category', 'manufacturer', 'supplier', 'barcode', 'unit', 'warranty_info'];

function itemValues(body) {
  const v = {};
  for (const f of ITEM_FIELDS) v[f] = fmt.clean(body[f], f === 'description' ? 2000 : 200);
  if (!v.sku || !v.name) throw new Error('SKU and name are required.');
  v.unit = v.unit || 'each';
  v.price_cents = fmt.toCents(body.price) || 0;
  v.preferred_vendor_id = parseInt(body.preferred_vendor_id, 10) || null;
  if (v.price_cents < 0) throw new Error('Price cannot be negative.');
  return v;
}

// ---------------------------------------------------------------- overview
router.get('/inventory', requirePermission('inventory.view', 'inventory.manage'), async (req, res) => {
  const q = req.query.q || '';
  const category = req.query.category || '';
  const [items, low, values, locations, categories] = await Promise.all([
    inventory.listItems({ q: q || null, category: category || null }), inventory.lowStock(), inventory.valueByLocation(), inventory.listLocations(), inventory.categories(),
  ]);
  const pendingParts = req.can('inventory.manage') ? (await db.prepare("SELECT COUNT(*) AS c FROM parts_requests WHERE status = 'pending'").get()).c : 0;
  res.render('inventory-list', { title: 'Inventory', items, low, values, locations, categories, q, category, pendingParts, totalValue: values.reduce((s, v) => s + v.value, 0) });
});

router.get('/inventory/items/new', requirePermission('inventory.manage'), async (req, res) => {
  res.render('inventory-item-form', { title: 'New Item', item: { unit: 'each' }, isNew: true, categories: await inventory.categories(), vendors: await db.prepare('SELECT id, name FROM vendors WHERE active = 1 ORDER BY name').all() });
});

router.post('/inventory/items/new', requirePermission('inventory.manage'), action(async (req, res) => {
  const v = itemValues(req.body);
  if (await db.prepare('SELECT 1 AS x FROM inventory_items WHERE LOWER(sku) = LOWER(?)').get(v.sku)) throw new Error(`SKU ${v.sku} already exists.`);
  const info = await db
    .prepare(`INSERT INTO inventory_items (${ITEM_FIELDS.join(', ')}, price_cents, preferred_vendor_id) VALUES (${ITEM_FIELDS.map(() => '?').join(', ')}, ?, ?)`)
    .run(...ITEM_FIELDS.map((f) => v[f]), v.price_cents, v.preferred_vendor_id);
  const wh = await inventory.warehouse();
  const min = fmt.toNumber(req.body.min_quantity);
  if (min) await inventory.setMin(info.lastInsertRowid, wh.id, min, fmt.clean(req.body.bin, 50));
  await audit.log(req, 'inventory_item.create', 'inventory_item', info.lastInsertRowid);
  flash(res, `/inventory/items/${info.lastInsertRowid}`, 'notice', 'Item created. Receive stock below to add quantity and cost.');
}, '/inventory/items/new'));

async function loadItem(req, res, next) {
  const item = await inventory.getItem(req.params.id);
  if (!item) return res.status(404).render('404', { title: 'Not Found' });
  req.item = item;
  next();
}
const itemBack = (req) => `/inventory/items/${req.params.id}`;

router.get('/inventory/items/:id', requirePermission('inventory.view', 'inventory.manage'), loadItem, async (req, res) => {
  const [stock, history, locations, categories] = await Promise.all([inventory.stockForItem(req.item.id), inventory.transactions({ itemId: req.item.id, limit: 100 }), inventory.listLocations(), inventory.categories()]);
  res.render('inventory-item', { title: req.item.name, item: req.item, stock, history, locations, categories, vendors: await db.prepare('SELECT id, name FROM vendors WHERE active = 1 ORDER BY name').all() });
});

router.post('/inventory/items/:id/edit', requirePermission('inventory.manage'), loadItem, action(async (req, res) => {
  const v = itemValues(req.body);
  const dup = await db.prepare('SELECT id FROM inventory_items WHERE LOWER(sku) = LOWER(?) AND id <> ?').get(v.sku, req.item.id);
  if (dup) throw new Error(`SKU ${v.sku} is used by another item.`);
  await db
    .prepare(`UPDATE inventory_items SET ${ITEM_FIELDS.map((f) => `${f} = ?`).join(', ')}, price_cents = ?, preferred_vendor_id = ?, active = ? WHERE id = ?`)
    .run(...ITEM_FIELDS.map((f) => v[f]), v.price_cents, v.preferred_vendor_id, req.body.active === '0' ? 0 : 1, req.item.id);
  await audit.log(req, 'inventory_item.update', 'inventory_item', req.item.id);
  flash(res, itemBack(req), 'notice', 'Item saved.');
}, itemBack));

router.post('/inventory/items/:id/receive', requirePermission('inventory.manage'), loadItem, action(async (req, res) => {
  const qty = fmt.toNumber(req.body.quantity);
  const cost = fmt.toCents(req.body.unit_cost);
  await inventory.receive({ itemId: req.item.id, locationId: parseInt(req.body.location_id, 10), qty, unitCostCents: cost, fundingCode: req.body.funding, reference: fmt.clean(req.body.reference, 200), memberId: req.member.id });
  await audit.log(req, 'inventory.receive', 'inventory_item', req.item.id, { qty, cost, location: req.body.location_id });
  flash(res, itemBack(req), 'notice', `Received ${qty}.`);
}, itemBack));

router.post('/inventory/items/:id/transfer', requirePermission('inventory.manage'), loadItem, action(async (req, res) => {
  const qty = fmt.toNumber(req.body.quantity);
  await inventory.transfer({ itemId: req.item.id, fromId: parseInt(req.body.from_id, 10), toId: parseInt(req.body.to_id, 10), qty, note: fmt.clean(req.body.note, 300), memberId: req.member.id });
  await audit.log(req, 'inventory.transfer', 'inventory_item', req.item.id, { qty, from: req.body.from_id, to: req.body.to_id });
  flash(res, itemBack(req), 'notice', `Transferred ${qty}.`);
}, itemBack));

router.post('/inventory/items/:id/count', requirePermission('inventory.manage'), loadItem, action(async (req, res) => {
  const counted = fmt.toNumber(req.body.counted);
  const { change } = await inventory.adjust({ itemId: req.item.id, locationId: parseInt(req.body.location_id, 10), countedQty: counted, reason: fmt.clean(req.body.reason, 300), memberId: req.member.id });
  await audit.log(req, 'inventory.count', 'inventory_item', req.item.id, { location: req.body.location_id, counted, change });
  flash(res, itemBack(req), 'notice', change ? `Count recorded: ${change > 0 ? '+' : ''}${change}. ${change < 0 ? 'Missing stock was posted to shrinkage.' : ''}` : 'Count matches - no change.');
}, itemBack));

router.post('/inventory/items/:id/minimum', requirePermission('inventory.manage'), loadItem, action(async (req, res) => {
  const min = fmt.toNumber(req.body.min_quantity) || 0;
  if (min < 0) throw new Error('Minimum cannot be negative.');
  await inventory.setMin(req.item.id, parseInt(req.body.location_id, 10), min, fmt.clean(req.body.bin, 50));
  flash(res, itemBack(req), 'notice', 'Minimum / bin saved.');
}, itemBack));

router.get('/inventory/locations/:id', requirePermission('inventory.view', 'inventory.manage'), async (req, res) => {
  const loc = await inventory.getLocation(req.params.id);
  if (!loc) return res.status(404).render('404', { title: 'Not Found' });
  const stock = await inventory.stockAt(loc.id);
  res.render('inventory-location', { title: loc.name, loc, stock, history: await inventory.transactions({ locationId: loc.id, limit: 100 }), value: stock.reduce((s, r) => s + r.quantity * r.unit_cost_cents, 0) });
});

router.get('/inventory/transactions', requirePermission('inventory.view', 'inventory.manage'), async (req, res) => {
  const rows = await inventory.transactions({ limit: 500 });
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment('inventory-transactions.csv');
    return res.send(fmt.csv(rows, [
      { label: 'Date', value: (r) => fmt.dt(r.created_at) }, { label: 'Item', value: 'itemName' }, { label: 'SKU', value: 'sku' }, { label: 'Location', value: 'locationName' },
      { label: 'Kind', value: 'kind' }, { label: 'Change', value: 'quantity_change' }, { label: 'Unit cost', value: (r) => fmt.centsInput(r.unit_cost_cents) },
      { label: 'Job', value: 'job_number' }, { label: 'By', value: 'memberName' }, { label: 'Note', value: 'note' },
    ]));
  }
  res.render('inventory-transactions', { title: 'Inventory History', rows });
});

// ---------------------------------------------------------------- parts requests
router.get('/inventory/parts-requests', requirePermission('inventory.manage'), async (req, res) => {
  const rows = await db
    .prepare(`SELECT pr.*, m.name AS "memberName", i.name AS "itemName", i.sku, j.job_number, d.name AS "decidedByName",
        (SELECT l.id FROM trucks t JOIN inventory_locations l ON l.truck_id = t.id WHERE t.assigned_member_id = pr.member_id AND t.active = 1 ORDER BY t.id LIMIT 1) AS "truckLocationId"
      FROM parts_requests pr JOIN members m ON m.id = pr.member_id LEFT JOIN inventory_items i ON i.id = pr.item_id LEFT JOIN jobs j ON j.id = pr.job_id LEFT JOIN members d ON d.id = pr.decided_by
      ORDER BY CASE pr.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, pr.id DESC LIMIT 300`)
    .all();
  res.render('inventory-parts', { title: 'Parts Requests', rows, warehouse: await inventory.warehouse() });
});

router.post('/inventory/parts-requests/:id/decide', requirePermission('inventory.manage'), action(async (req, res) => {
  const pr = await db.prepare('SELECT * FROM parts_requests WHERE id = ?').get(req.params.id);
  if (!pr) throw new Error('Request not found.');
  const decision = req.body.decision;
  if (!['approved', 'rejected', 'fulfilled'].includes(decision)) throw new Error('Invalid decision.');
  if (pr.status === 'fulfilled' || pr.status === 'rejected') throw new Error('This request is already closed.');
  let note = fmt.clean(req.body.note, 500);
  if (decision === 'fulfilled' && req.body.transfer === '1') {
    if (!pr.item_id) throw new Error('This request is not linked to a catalog item, so it cannot be transferred automatically.');
    const truck = await db.prepare('SELECT l.id, l.name FROM trucks t JOIN inventory_locations l ON l.truck_id = t.id WHERE t.assigned_member_id = ? AND t.active = 1 ORDER BY t.id LIMIT 1').get(pr.member_id);
    if (!truck) throw new Error('The requester has no truck assigned; fulfil it manually.');
    const wh = await inventory.warehouse();
    await inventory.transfer({ itemId: pr.item_id, fromId: wh.id, toId: truck.id, qty: Number(pr.quantity), note: `Parts request #${pr.id}`, memberId: req.member.id });
    note = [note, `Transferred ${pr.quantity} from ${wh.name} to ${truck.name}`].filter(Boolean).join(' · ');
  }
  await db.prepare('UPDATE parts_requests SET status = ?, decided_by = ?, decided_at = now_text(), decision_note = ? WHERE id = ?').run(decision, req.member.id, note, pr.id);
  await audit.log(req, 'parts_request.' + decision, 'parts_request', pr.id);
  await notifications.notify(pr.member_id, 'parts_request', { title: `Parts request ${decision}`, body: `${pr.quantity} x ${pr.description}${note ? ' - ' + note : ''}`, linkUrl: '/employee/parts' });
  flash(res, '/inventory/parts-requests', 'notice', `Request ${decision}.`);
}, '/inventory/parts-requests'));

// ---------------------------------------------------------------- trucks
router.get('/trucks', requirePermission('trucks.manage', 'inventory.manage'), async (req, res) => {
  const trucks = await db
    .prepare(`SELECT t.*, m.name AS "assignedName", l.id AS "locationId", COALESCE((SELECT SUM(s.quantity * i.unit_cost_cents) FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id WHERE s.location_id = l.id), 0) AS "stockValue"
      FROM trucks t LEFT JOIN members m ON m.id = t.assigned_member_id LEFT JOIN inventory_locations l ON l.truck_id = t.id ORDER BY t.active DESC, t.name`)
    .all();
  const staff = await db.prepare('SELECT id, name FROM members WHERE active = 1 ORDER BY name').all();
  res.render('trucks', { title: 'Trucks', trucks, staff });
});

router.post('/trucks/new', requirePermission('trucks.manage'), action(async (req, res) => {
  const name = fmt.clean(req.body.name, 100);
  if (!name) throw new Error('Truck name is required.');
  if (await db.prepare('SELECT 1 AS x FROM trucks WHERE LOWER(name) = LOWER(?)').get(name)) throw new Error('A truck with that name already exists.');
  await db.withTransaction(async (tx) => {
    const info = await tx
      .prepare('INSERT INTO trucks (name, plate, vin, make_model, year, assigned_member_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, fmt.clean(req.body.plate, 20), fmt.clean(req.body.vin, 40), fmt.clean(req.body.make_model, 100), parseInt(req.body.year, 10) || null, parseInt(req.body.assigned_member_id, 10) || null, fmt.clean(req.body.notes, 1000));
    await tx.prepare("INSERT INTO inventory_locations (kind, name, truck_id) VALUES ('truck', ?, ?)").run(name, info.lastInsertRowid);
    await audit.log(req, 'truck.create', 'truck', info.lastInsertRowid, null, tx);
  });
  flash(res, '/trucks', 'notice', 'Truck added with its own inventory location.');
}, '/trucks'));

router.post('/trucks/:id/edit', requirePermission('trucks.manage'), action(async (req, res) => {
  const truck = await db.prepare('SELECT * FROM trucks WHERE id = ?').get(req.params.id);
  if (!truck) throw new Error('Truck not found.');
  const name = fmt.clean(req.body.name, 100) || truck.name;
  const memberId = parseInt(req.body.assigned_member_id, 10) || null;
  await db.withTransaction(async (tx) => {
    // One truck per technician: unassign them from any other truck.
    if (memberId) await tx.prepare('UPDATE trucks SET assigned_member_id = NULL WHERE assigned_member_id = ? AND id <> ?').run(memberId, truck.id);
    await tx
      .prepare('UPDATE trucks SET name = ?, plate = ?, vin = ?, make_model = ?, year = ?, assigned_member_id = ?, active = ?, notes = ? WHERE id = ?')
      .run(name, fmt.clean(req.body.plate, 20), fmt.clean(req.body.vin, 40), fmt.clean(req.body.make_model, 100), parseInt(req.body.year, 10) || null, memberId, req.body.active === '0' ? 0 : 1, fmt.clean(req.body.notes, 1000), truck.id);
    await tx.prepare('UPDATE inventory_locations SET name = ?, active = ? WHERE truck_id = ?').run(name, req.body.active === '0' ? 0 : 1, truck.id);
    await audit.log(req, 'truck.update', 'truck', truck.id, { assigned: memberId }, tx);
  });
  if (memberId && memberId !== truck.assigned_member_id) await notifications.notify(memberId, 'job_assigned', { title: `You've been assigned truck ${name}`, linkUrl: '/employee/truck' });
  flash(res, '/trucks', 'notice', 'Truck saved.');
}, '/trucks'));

module.exports = router;
