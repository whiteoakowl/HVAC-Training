// Sample HVAC business data for local development and demos. Skipped if
// any customer already exists, so it can never mix into real data.
// Goes through the same utils the app uses, so ledger postings,
// inventory transactions and numbering are all real.
const db = require('./index');
const { createMember, findByEmail } = require('../utils/auth');
const customers = require('../utils/customers');
const inventory = require('../utils/inventory');
const jobs = require('../utils/jobs');
const settings = require('../utils/settings');
const fmt = require('../utils/format');

const STAFF = [
  ['Morgan Hale', 'gm@hvacdemo.test', 'general_manager', 'General Manager'],
  ['Riley Brooks', 'office@hvacdemo.test', 'office_manager', 'Office Manager'],
  ['Avery Chen', 'accounting@hvacdemo.test', 'accounting', 'Bookkeeper'],
  ['Jamie Ortiz', 'csr@hvacdemo.test', 'customer_service', 'Customer Service Rep'],
  ['Drew Patel', 'dispatch@hvacdemo.test', 'dispatcher', 'Dispatcher'],
  ['Taylor Reed', 'servicemgr@hvacdemo.test', 'service_manager', 'Service Manager'],
  ['Chris Walker', 'lead@hvacdemo.test', 'lead_technician', 'Lead Technician'],
  ['Sam Rivera', 'tech@hvacdemo.test', 'technician', 'Service Technician'],
  ['Alex Kim', 'installer@hvacdemo.test', 'installer', 'Installer'],
  ['Pat Morgan', 'warehouse@hvacdemo.test', 'warehouse_manager', 'Warehouse Manager'],
];

module.exports = async function seedDemo(password) {
  if (await db.prepare('SELECT 1 AS x FROM customers LIMIT 1').get()) return;
  const ids = {};
  for (const [name, email, role, title] of STAFF) {
    const existing = await findByEmail(email);
    const id = existing ? existing.id : await createMember({ name, email, password, role });
    ids[role] = id;
    const hourly = ['technician', 'lead_technician', 'installer', 'warehouse_manager', 'customer_service', 'dispatcher'].includes(role);
    await db
      .prepare("INSERT INTO employee_profiles (member_id, employee_number, job_title, hire_date, pay_type, pay_rate_cents) VALUES (?, ?, ?, '2024-03-01', ?, ?) ON CONFLICT (member_id) DO NOTHING")
      .run(id, 'E' + String(id).padStart(4, '0'), title, hourly ? 'hourly' : 'salary', hourly ? 3200 : 6500000);
  }
  const admin = await findByEmail('admin@hvactraining.test');
  const owner = admin ? admin.id : ids.general_manager;
  await db.prepare("INSERT INTO certifications (member_id, name, number, issued_on, expires_on) VALUES (?, 'EPA 608 Universal', 'U-55821', '2022-05-01', NULL)").run(ids.technician);
  await db.prepare("INSERT INTO certifications (member_id, name, number, issued_on, expires_on) VALUES (?, 'NATE Air Conditioning', 'N-1182', '2023-01-15', ?)").run(ids.lead_technician, fmt.addDays(fmt.today(), 45));

  if ((await settings.get('company_name')) === 'HVAC Company') {
    await settings.set('company_name', 'Demo Heating & Air');
    await settings.set('company_phone', '(555) 010-2000');
    await settings.set('default_tax_rate_bp', '700');
  }

  // Trucks, each with its own inventory location.
  const truck = async (name, memberId) => {
    const info = await db.prepare('INSERT INTO trucks (name, make_model, year, assigned_member_id) VALUES (?, ?, ?, ?)').run(name, 'Ford Transit 250', 2022, memberId);
    const loc = await db.prepare("INSERT INTO inventory_locations (kind, name, truck_id) VALUES ('truck', ?, ?)").run(name, info.lastInsertRowid);
    return { id: info.lastInsertRowid, locationId: loc.lastInsertRowid };
  };
  const t1 = await truck('Truck 1', ids.lead_technician);
  const t2 = await truck('Truck 2', ids.technician);
  const wh = await inventory.warehouse();

  const ITEMS = [
    ['FLT-16251', '16x25x1 Pleated Filter MERV 8', 'Filters', 'each', 450, 1800, 40],
    ['CAP-4553', 'Dual Run Capacitor 45/5 MFD 440V', 'Capacitors', 'each', 1200, 8500, 10],
    ['CON-2P30', 'Contactor 2-Pole 30A 24V Coil', 'Contactors', 'each', 1500, 9500, 6],
    ['IGN-HSI41', 'Hot Surface Igniter (universal)', 'Igniters & Sensors', 'each', 2200, 14500, 4],
    ['REF-410A', 'R-410A Refrigerant', 'Refrigerant', 'lb', 1100, 9500, 25],
    ['THM-T6PRO', 'Programmable Thermostat', 'Thermostats', 'each', 6500, 22500, 3],
  ];
  const vendor = await db.prepare("INSERT INTO vendors (name, contact_name, phone, email, terms_days) VALUES ('Demo HVAC Supply', 'Counter Sales', '(555) 400-1000', 'orders@demosupply.example.com', 30)").run();
  const itemIds = {};
  for (const [sku, name, category, unit, cost, price, min] of ITEMS) {
    const info = await db.prepare('INSERT INTO inventory_items (sku, name, category, unit, price_cents, supplier, preferred_vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sku, name, category, unit, price, 'Demo HVAC Supply', vendor.lastInsertRowid);
    itemIds[sku] = info.lastInsertRowid;
    await inventory.setMin(info.lastInsertRowid, wh.id, min);
    await inventory.receive({ itemId: info.lastInsertRowid, locationId: wh.id, qty: min * 3, unitCostCents: cost, fundingCode: '2000', reference: 'Opening stock', memberId: owner });
    for (const t of [t1, t2]) {
      await inventory.transfer({ itemId: info.lastInsertRowid, fromId: wh.id, toId: t.locationId, qty: Math.max(1, Math.round(min / 3)), memberId: owner });
      await inventory.setMin(info.lastInsertRowid, t.locationId, 1);
    }
  }

  // Customers with properties and equipment.
  const c1 = await customers.create({ name: 'Dana Whitfield', email: 'dana.whitfield@example.com', phone: '(555) 201-3344', billing_address: '412 Maple Ave, Springfield, IL 62701', source: 'demo' });
  const p1 = await customers.addProperty(c1, { label: 'Home', address: '412 Maple Ave', city: 'Springfield', state: 'IL', zip: '62701', access_notes: 'Side gate code 4411. Friendly dog.' });
  await customers.addEquipment(p1, { equipment_type: 'Furnace', manufacturer: 'Carrier', model_number: '59SC5A060', serial_number: 'C1234A5678', install_date: '2016-10-12', filter_size: '16x25x1', location_notes: 'Basement' });
  await customers.addEquipment(p1, { equipment_type: 'Air Conditioner', manufacturer: 'Carrier', model_number: '24ACC636', serial_number: 'C9988B7766', install_date: '2016-10-12', refrigerant_type: 'R-410A', warranty_expires: '2026-10-12' });
  const c2 = await customers.create({ account_type: 'commercial', name: 'Luis Romero', company_name: 'Romero Family Dental', email: 'office@romerodental.example.com', phone: '(555) 330-7781', billing_address: '88 Commerce Dr, Springfield, IL 62704', source: 'demo' });
  const p2 = await customers.addProperty(c2, { label: 'Office', address: '88 Commerce Dr', city: 'Springfield', state: 'IL', zip: '62704' });
  await customers.addEquipment(p2, { equipment_type: 'Rooftop Unit', manufacturer: 'Trane', model_number: 'YSC060', serial_number: 'T5544RT', install_date: '2019-04-02', refrigerant_type: 'R-410A' });
  const c3 = await customers.create({ name: 'Priya Nair', email: 'priya.nair@example.com', phone: '(555) 778-1200', source: 'demo' });
  const p3 = await customers.addProperty(c3, { address: '19 Lakeview Ct', city: 'Chatham', state: 'IL', zip: '62629' });

  const today = fmt.today();
  const j1 = await jobs.create({ customer_id: c1, property_id: p1, title: 'No heat - furnace not igniting', job_type: 'repair', priority: 'high', estimated_hours: 1.5 }, ids.customer_service);
  await jobs.assign(j1, { memberIds: [ids.lead_technician], truckId: t1.id, start: `${today} 09:00:00`, end: `${today} 10:30:00` }, ids.dispatcher);
  const j2 = await jobs.create({ customer_id: c2, property_id: p2, title: 'Spring maintenance - rooftop unit', job_type: 'maintenance', estimated_hours: 2, quoted_price_cents: 18900 }, ids.customer_service);
  await jobs.assign(j2, { memberIds: [ids.technician], truckId: t2.id, start: `${fmt.addDays(today, 1)} 13:00:00`, end: `${fmt.addDays(today, 1)} 15:00:00` }, ids.dispatcher);
  await jobs.create({ customer_id: c3, property_id: p3, title: 'Estimate - replace 20-year-old AC', job_type: 'estimate', status: 'estimate_requested' }, ids.customer_service);
  await db
    .prepare("INSERT INTO service_requests (request_number, customer_id, property_id, kind, description, preferred_time, source, status) VALUES ('SR-DEMO1', ?, ?, 'maintenance', 'Would like a fall tune-up before winter.', 'Morning', 'wix', 'new')")
    .run(c3, p3);
  // Maintenance plan + agreement, an estimate awaiting approval, a customer portal login.
  await require('../utils/agreements').savePlan(null, { name: 'Comfort Club', description: 'Two tune-ups a year', included_services: 'Spring AC tune-up\nFall furnace safety inspection\n15% off repairs\nPriority scheduling', visits_per_year: '2', term_months: '12', price: '189' });
  const plan = await db.prepare("SELECT id FROM maintenance_plans WHERE name = 'Comfort Club'").get();
  const eq = await db.prepare('SELECT id FROM equipment WHERE property_id = ?').all(p1);
  await require('../utils/agreements').create({ customer_id: c1, property_id: p1, plan_id: plan.id, start_date: fmt.addDays(today, -150), auto_renew: '1', equipment_ids: eq.map((e) => String(e.id)) }, owner);
  const estimates = require('../utils/estimates');
  const estId = await estimates.create({ customer_id: c3, property_id: p3, title: 'Replace 3-ton AC condenser and coil', scope: 'Remove existing 20-year-old R-22 condenser and evaporator coil. Install new 16 SEER2 R-454B system, new line set, pad and disconnect. Haul away old equipment.' }, ids.lead_technician);
  await estimates.addLine(estId, { kind: 'equipment', description: '3-ton 16 SEER2 condenser + matching coil', quantity: 1, unitPriceCents: 520000, taxable: true });
  await estimates.addLine(estId, { kind: 'labor', description: 'Installation labor (2 techs)', quantity: 10, unitPriceCents: 12500, taxable: false });
  await estimates.addLine(estId, { kind: 'permit', description: 'Mechanical permit', quantity: 1, unitPriceCents: 8500, taxable: false });
  await estimates.update(estId, { title: 'Replace 3-ton AC condenser and coil', scope: 'Remove existing 20-year-old R-22 condenser and evaporator coil. Install new 16 SEER2 R-454B system.', property_id: p3, discount: '0', tax_rate: '7', deposit: '1500', payment_schedule: 'Deposit to order equipment, balance on completion', expires_on: fmt.addDays(today, 30) });
  await estimates.markSent(estId);
  const custMember = await createMember({ name: 'Dana Whitfield', email: 'customer@hvacdemo.test', password, role: 'customer' });
  await db.prepare('UPDATE customers SET member_id = ? WHERE id = ?').run(custMember, c1);
  await db.prepare("INSERT INTO announcements (title, body, pinned, created_by) VALUES ('Welcome to the new system', 'Clock in from My Day, record materials on each job, and submit your end-of-day report before you leave.', 1, ?)").run(owner);

  console.log('Demo business data loaded (staff logins: gm@, office@, accounting@, csr@, dispatch@, servicemgr@, lead@, tech@, installer@, warehouse@ hvacdemo.test; customer portal: customer@hvacdemo.test).');
};
