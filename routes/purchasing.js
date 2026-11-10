// Vendors, purchase orders (supply lists), receiving, vendor bills (A/P).
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const purchasing = require('../utils/purchasing');
const inventory = require('../utils/inventory');
const accounting = require('../utils/accounting');
const automation = require('../utils/automation');
const notifications = require('../utils/notifications');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action, asArray } = require('../utils/http');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.use(['/vendors', '/purchasing', '/bills'], requireAuth);

// ---------------------------------------------------------------- vendors
router.get('/vendors', requirePermission('purchasing.manage', 'bills.manage'), async (req, res) => {
  res.render('vendors', { title: 'Vendors', vendors: await purchasing.listVendors() });
});

router.post('/vendors', requirePermission('purchasing.manage', 'bills.manage'), action(async (req, res) => {
  const id = await purchasing.saveVendor(parseInt(req.body.id, 10) || null, req.body);
  await audit.log(req, req.body.id ? 'vendor.update' : 'vendor.create', 'vendor', id);
  flash(res, '/vendors', 'notice', 'Vendor saved.');
}, '/vendors'));

// ---------------------------------------------------------------- purchase orders
router.get('/purchasing', requirePermission('purchasing.manage', 'purchasing.approve'), async (req, res) => {
  const status = purchasing.PO_STATUSES.includes(req.query.status) ? req.query.status : null;
  const open = !status && req.query.all !== '1';
  res.render('purchasing-list', {
    title: 'Purchase Orders', rows: await purchasing.listPOs({ status, open }), status, open, statuses: purchasing.PO_STATUSES,
    vendors: await purchasing.listVendors({ activeOnly: true }), locations: await inventory.listLocations(), low: (await inventory.lowStock()).filter((l) => l.kind === 'warehouse'),
  });
});

router.post('/purchasing/new', requirePermission('purchasing.manage'), action(async (req, res) => {
  const id = await purchasing.createPO({ vendorId: parseInt(req.body.vendor_id, 10), locationId: parseInt(req.body.location_id, 10), expectedOn: req.body.expected_on, notes: req.body.notes }, req.member.id);
  await audit.log(req, 'po.create', 'purchase_order', id);
  flash(res, `/purchasing/${id}`, 'notice', 'Purchase order created. Add the items to order.');
}, '/purchasing'));

router.post('/purchasing/from-low-stock', requirePermission('purchasing.manage'), action(async (req, res) => {
  const { created, skipped } = await purchasing.draftFromLowStock(req.member.id);
  await audit.log(req, 'po.restock', null, null, { created });
  const msg = `${created.length} draft purchase order(s) created.${skipped.length ? ` Skipped (no preferred vendor set): ${skipped.join(', ')}.` : ''}`;
  flash(res, '/purchasing', created.length ? 'notice' : 'error', created.length ? msg : `Nothing to order.${skipped.length ? ' Set a preferred vendor on: ' + skipped.join(', ') : ''}`);
}, '/purchasing'));

async function loadPO(req, res, next) {
  const po = await purchasing.getPO(req.params.id);
  if (!po) return res.status(404).render('404', { title: 'Not Found' });
  req.po = po;
  next();
}
const poBack = (req) => `/purchasing/${req.params.id}`;

router.get('/purchasing/:id', requirePermission('purchasing.manage', 'purchasing.approve', 'bills.manage'), loadPO, async (req, res) => {
  res.render('purchasing-po', {
    title: req.po.po_number, po: req.po, items: await inventory.listItems(), expenseAccounts: (await accounting.listAccounts({ activeOnly: true })).filter((a) => ['expense', 'cogs'].includes(a.type)),
    receipts: await db.prepare('SELECT r.*, pl.description, m.name AS "memberName" FROM po_receipts r JOIN purchase_order_lines pl ON pl.id = r.line_id LEFT JOIN members m ON m.id = r.member_id WHERE r.po_id = ? ORDER BY r.id').all(req.po.id),
  });
});

router.post('/purchasing/:id/lines', requirePermission('purchasing.manage'), loadPO, action(async (req, res) => {
  const cost = req.body.unit_cost === '' ? null : fmt.toCents(req.body.unit_cost);
  await purchasing.addPOLine(req.po.id, { itemId: parseInt(req.body.item_id, 10) || null, description: req.body.description, quantity: fmt.toNumber(req.body.quantity), unitCostCents: cost });
  flash(res, poBack(req), 'notice', 'Line added.');
}, poBack));

router.post('/purchasing/:id/lines/:lineId/delete', requirePermission('purchasing.manage'), loadPO, action(async (req, res) => {
  await purchasing.removePOLine(req.po.id, req.params.lineId);
  flash(res, poBack(req), 'notice', 'Line removed.');
}, poBack));

router.post('/purchasing/:id/status', requirePermission('purchasing.manage', 'purchasing.approve'), loadPO, action(async (req, res) => {
  const act = req.body.action;
  if (['submit', 'order', 'cancel'].includes(act) && !req.can('purchasing.manage')) throw new Error('You do not have permission to do that.');
  const r = await purchasing.setPOStatus(req.po.id, act, req.member.id, { canApprove: req.can('purchasing.approve') });
  await audit.log(req, 'po.' + act, 'purchase_order', req.po.id, r);
  if (act === 'submit') await automation.notifyPermission(['purchasing.approve'], 'parts_request', { title: `PO ${req.po.po_number} needs approval`, body: `${req.po.vendorName} - ${fmt.money(req.po.total_cents)}`, linkUrl: poBack(req) }, req.member.id);
  if (['approve', 'reject'].includes(act) && req.po.created_by) await notifications.notify(req.po.created_by, 'parts_request', { title: `PO ${req.po.po_number} ${r.to}`, linkUrl: poBack(req) });
  flash(res, poBack(req), 'notice', `Purchase order ${fmt.label(r.to).toLowerCase()}.`);
}, poBack));

router.post('/purchasing/:id/receive', requirePermission('purchasing.manage'), loadPO, action(async (req, res) => {
  const quantities = {};
  for (const l of req.po.lines) quantities[l.id] = fmt.toNumber(req.body['qty_' + l.id]) || 0;
  const status = await purchasing.receivePO(req.po.id, quantities, req.member.id);
  await audit.log(req, 'po.receive', 'purchase_order', req.po.id, { quantities });
  flash(res, poBack(req), 'notice', status === 'received' ? 'Order fully received into inventory.' : 'Partial delivery received. Remaining items stay on backorder.');
}, poBack));

router.post('/purchasing/:id/bill', requirePermission('bills.manage'), loadPO, upload.single('attachment'), action(async (req, res) => {
  const id = await purchasing.billPO(req.po.id, { billNumber: req.body.bill_number, billDate: req.body.bill_date, dueDate: req.body.due_date, expenseAccountId: parseInt(req.body.expense_account_id, 10) || null, attachment: req.file }, req.member.id);
  await audit.log(req, 'bill.create', 'vendor_bill', id, { poId: req.po.id });
  flash(res, `/bills/${id}`, 'notice', 'Vendor bill entered and matched to the purchase order.');
}, poBack));

// ---------------------------------------------------------------- bills / A/P
router.get('/bills', requirePermission('bills.manage'), async (req, res) => {
  const status = ['open', 'paid', 'void', 'partial'].includes(req.query.status) ? req.query.status : 'open';
  res.render('bills-list', {
    title: 'Vendor Bills', rows: await purchasing.listBills({ status }), status, aging: await purchasing.apAging(), vendors: await purchasing.listVendors({ activeOnly: true }),
    accounts: (await accounting.listAccounts({ activeOnly: true })).filter((a) => ['expense', 'cogs', 'asset'].includes(a.type)), today: fmt.today(),
  });
});

router.post('/bills/new', requirePermission('bills.manage'), upload.single('attachment'), action(async (req, res) => {
  const accts = asArray(req.body.account_id);
  const amounts = asArray(req.body.amount);
  const descs = asArray(req.body.line_description);
  const lines = accts.map((a, i) => ({ accountId: parseInt(a, 10), amountCents: fmt.toCents(amounts[i]), description: descs[i] })).filter((l) => l.accountId && l.amountCents);
  const id = await purchasing.createBill({ vendorId: parseInt(req.body.vendor_id, 10), billNumber: req.body.bill_number, billDate: req.body.bill_date, dueDate: req.body.due_date, memo: req.body.memo, lines, attachment: req.file }, req.member.id);
  await audit.log(req, 'bill.create', 'vendor_bill', id);
  flash(res, `/bills/${id}`, 'notice', 'Bill entered into accounts payable.');
}, '/bills'));

async function loadBill(req, res, next) {
  const b = await purchasing.getBill(req.params.id);
  if (!b) return res.status(404).render('404', { title: 'Not Found' });
  req.bill = b;
  next();
}
const billBack = (req) => `/bills/${req.params.id}`;

router.get('/bills/:id', requirePermission('bills.manage'), loadBill, (req, res) => {
  res.render('bill', { title: `Bill ${req.bill.bill_number || '#' + req.bill.id}`, b: req.bill, methods: purchasing.PAY_METHODS, today: fmt.today() });
});

router.get('/bills/:id/attachment', requirePermission('bills.manage'), async (req, res) => {
  const b = await db.prepare('SELECT attachment, attachment_name, attachment_mime FROM vendor_bills WHERE id = ?').get(req.params.id);
  if (!b || !b.attachment) return res.status(404).render('404', { title: 'Not Found' });
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(b.attachment_mime || '');
  res.set('X-Content-Type-Options', 'nosniff').type(inline ? b.attachment_mime : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(b.attachment_name || 'bill').replace(/[^\w.\- ]/g, '_')}"`);
  res.send(Buffer.from(b.attachment));
});

router.post('/bills/:id/pay', requirePermission('bills.manage'), loadBill, action(async (req, res) => {
  const amount = fmt.toCents(req.body.amount);
  await purchasing.payBill(req.bill.id, { amountCents: amount, method: req.body.method, reference: req.body.reference, paidOn: req.body.paid_on }, req.member.id);
  await audit.log(req, 'bill.pay', 'vendor_bill', req.bill.id, { amount, method: req.body.method });
  flash(res, billBack(req), 'notice', 'Payment recorded.');
}, billBack));

router.post('/bills/:id/void', requirePermission('bills.manage'), loadBill, action(async (req, res) => {
  await purchasing.voidBill(req.bill.id, req.body.reason, req.member.id);
  await audit.log(req, 'bill.void', 'vendor_bill', req.bill.id, { reason: req.body.reason });
  flash(res, billBack(req), 'notice', 'Bill voided and its accounting entry reversed.');
}, billBack));

module.exports = router;
