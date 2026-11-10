// CRM: customers, properties (service addresses), equipment, and the
// communication log. findOrCreate() is the single entry point used by
// the office forms and the Wix integration so the same person never
// ends up as two customer records.
const db = require('../db');
const fmt = require('./format');

function normalizeEmail(e) {
  const s = fmt.clean(e, 200);
  return s ? s.toLowerCase() : null;
}

async function get(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

// Duplicate detection: same email, or same phone (last 10 digits).
async function findMatch({ email, phone }, tx = db) {
  const e = normalizeEmail(email);
  const p = fmt.phoneKey(phone);
  if (e) {
    const byEmail = await tx.prepare('SELECT * FROM customers WHERE email = ? OR alt_email = ? ORDER BY id LIMIT 1').get(e, e);
    if (byEmail) return byEmail;
  }
  if (p && p.length >= 7) {
    const byPhone = await tx.prepare('SELECT * FROM customers WHERE phone_digits = ? ORDER BY id LIMIT 1').get(p);
    if (byPhone) return byPhone;
  }
  return null;
}

async function create(data, memberId = null, tx = db) {
  const name = fmt.clean(data.name, 200);
  if (!name) throw new Error('Customer name is required.');
  const info = await tx
    .prepare(`INSERT INTO customers (account_type, name, company_name, email, alt_email, phone, phone_digits, alt_phone, billing_address, preferences, notes, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      data.account_type === 'commercial' ? 'commercial' : 'residential', name, fmt.clean(data.company_name, 200),
      normalizeEmail(data.email), normalizeEmail(data.alt_email), fmt.clean(data.phone, 40), fmt.phoneKey(data.phone), fmt.clean(data.alt_phone, 40),
      fmt.clean(data.billing_address, 500), fmt.clean(data.preferences, 2000), fmt.clean(data.notes, 5000), fmt.clean(data.source, 40) || 'office'
    );
  const id = info.lastInsertRowid;
  await tx.prepare('UPDATE customers SET customer_number = ? WHERE id = ?').run(fmt.number('C', id), id);
  void memberId;
  return id;
}

async function update(id, data) {
  const name = fmt.clean(data.name, 200);
  if (!name) throw new Error('Customer name is required.');
  await db
    .prepare(`UPDATE customers SET account_type = ?, name = ?, company_name = ?, email = ?, alt_email = ?, phone = ?, phone_digits = ?, alt_phone = ?, billing_address = ?, preferences = ?, notes = ?, active = ?, updated_at = now_text() WHERE id = ?`)
    .run(
      data.account_type === 'commercial' ? 'commercial' : 'residential', name, fmt.clean(data.company_name, 200), normalizeEmail(data.email), normalizeEmail(data.alt_email),
      fmt.clean(data.phone, 40), fmt.phoneKey(data.phone), fmt.clean(data.alt_phone, 40), fmt.clean(data.billing_address, 500), fmt.clean(data.preferences, 2000),
      fmt.clean(data.notes, 5000), data.active === '0' ? 0 : 1, id
    );
}

// Returns { customer, created }. Fills in blanks on an existing match but
// never overwrites what the office already has on file.
async function findOrCreate(data, memberId = null, tx = db) {
  const match = await findMatch(data, tx);
  if (match) {
    const email = normalizeEmail(data.email);
    if (!match.email && email) await tx.prepare('UPDATE customers SET email = ? WHERE id = ?').run(email, match.id);
    if (!match.phone && data.phone) await tx.prepare('UPDATE customers SET phone = ?, phone_digits = ? WHERE id = ?').run(fmt.clean(data.phone, 40), fmt.phoneKey(data.phone), match.id);
    return { customer: await tx.prepare('SELECT * FROM customers WHERE id = ?').get(match.id), created: false };
  }
  const id = await create(data, memberId, tx);
  return { customer: await tx.prepare('SELECT * FROM customers WHERE id = ?').get(id), created: true };
}

// Search by name, phone, email, address, customer #, job #, or equipment serial.
async function search(q, { limit = 100 } = {}) {
  const term = fmt.clean(q, 200);
  if (!term) {
    return db.prepare(`SELECT c.* FROM customers c ORDER BY c.updated_at DESC, c.id DESC LIMIT ${limit}`).all();
  }
  const like = `%${term.toLowerCase()}%`;
  const phone = fmt.digits(term);
  const phoneLike = phone.length >= 3 ? `%${phone}%` : '__no_match__';
  return db
    .prepare(`SELECT DISTINCT c.* FROM customers c
      LEFT JOIN properties p ON p.customer_id = c.id
      LEFT JOIN equipment e ON e.property_id = p.id
      LEFT JOIN jobs j ON j.customer_id = c.id
      WHERE LOWER(c.name) LIKE ? OR LOWER(COALESCE(c.company_name, '')) LIKE ? OR LOWER(COALESCE(c.email, '')) LIKE ? OR LOWER(COALESCE(c.alt_email, '')) LIKE ?
        OR COALESCE(c.phone_digits, '') LIKE ? OR LOWER(COALESCE(c.customer_number, '')) LIKE ? OR LOWER(COALESCE(c.billing_address, '')) LIKE ?
        OR LOWER(COALESCE(p.address, '')) LIKE ? OR LOWER(COALESCE(e.serial_number, '')) LIKE ? OR LOWER(COALESCE(j.job_number, '')) LIKE ?
      ORDER BY c.name LIMIT ${limit}`)
    .all(like, like, like, like, phoneLike, like, like, like, like, like);
}

async function properties(customerId) {
  return db.prepare('SELECT * FROM properties WHERE customer_id = ? ORDER BY id').all(customerId);
}

async function getProperty(id) {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
}

async function addProperty(customerId, data, tx = db) {
  const address = fmt.clean(data.address, 300);
  if (!address) throw new Error('Address is required.');
  const info = await tx
    .prepare('INSERT INTO properties (customer_id, label, address, city, state, zip, access_notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(customerId, fmt.clean(data.label, 100), address, fmt.clean(data.city, 100), fmt.clean(data.state, 40), fmt.clean(data.zip, 20), fmt.clean(data.access_notes, 2000));
  return info.lastInsertRowid;
}

async function updateProperty(id, data) {
  const address = fmt.clean(data.address, 300);
  if (!address) throw new Error('Address is required.');
  await db
    .prepare('UPDATE properties SET label = ?, address = ?, city = ?, state = ?, zip = ?, access_notes = ? WHERE id = ?')
    .run(fmt.clean(data.label, 100), address, fmt.clean(data.city, 100), fmt.clean(data.state, 40), fmt.clean(data.zip, 20), fmt.clean(data.access_notes, 2000), id);
}

// Reuse an existing property at the same street address (case-insensitive).
async function findOrAddProperty(customerId, data, tx = db) {
  const address = fmt.clean(data.address, 300);
  if (!address) return null;
  const existing = await tx.prepare('SELECT id FROM properties WHERE customer_id = ? AND LOWER(address) = LOWER(?)').get(customerId, address);
  if (existing) return existing.id;
  return addProperty(customerId, data, tx);
}

function propertyLine(p) {
  if (!p) return '';
  return [p.address, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

const EQUIPMENT_FIELDS = ['equipment_type', 'manufacturer', 'model_number', 'serial_number', 'install_date', 'warranty_expires', 'filter_size', 'refrigerant_type', 'location_notes'];

async function equipmentForCustomer(customerId) {
  return db
    .prepare('SELECT e.*, p.address, p.label AS "propertyLabel" FROM equipment e JOIN properties p ON p.id = e.property_id WHERE p.customer_id = ? ORDER BY p.id, e.id')
    .all(customerId);
}

async function getEquipment(id) {
  return db.prepare('SELECT e.*, p.customer_id FROM equipment e JOIN properties p ON p.id = e.property_id WHERE e.id = ?').get(id);
}

function equipmentValues(data) {
  const v = EQUIPMENT_FIELDS.map((f) => (['install_date', 'warranty_expires'].includes(f) ? fmt.dateOnly(data[f]) : fmt.clean(data[f], 200)));
  if (!v[0]) throw new Error('Equipment type is required.');
  return v;
}

async function addEquipment(propertyId, data) {
  const info = await db.prepare(`INSERT INTO equipment (property_id, ${EQUIPMENT_FIELDS.join(', ')}) VALUES (?, ${EQUIPMENT_FIELDS.map(() => '?').join(', ')})`).run(propertyId, ...equipmentValues(data));
  return info.lastInsertRowid;
}

async function updateEquipment(id, data) {
  await db.prepare(`UPDATE equipment SET ${EQUIPMENT_FIELDS.map((f) => `${f} = ?`).join(', ')}, active = ? WHERE id = ?`).run(...equipmentValues(data), data.active === '0' ? 0 : 1, id);
}

const CHANNELS = ['phone', 'email', 'sms', 'in_person', 'web', 'note', 'complaint', 'warranty'];

async function addInteraction(customerId, data, memberId, tx = db) {
  const summary = fmt.clean(data.summary, 5000);
  if (!summary) throw new Error('Enter a summary.');
  const channel = CHANNELS.includes(data.channel) ? data.channel : 'note';
  const direction = ['inbound', 'outbound', 'internal'].includes(data.direction) ? data.direction : 'inbound';
  const info = await tx
    .prepare('INSERT INTO customer_interactions (customer_id, member_id, channel, direction, summary, follow_up_on) VALUES (?, ?, ?, ?, ?, ?)')
    .run(customerId, memberId, channel, direction, summary, fmt.dateOnly(data.follow_up_on));
  await tx.prepare('UPDATE customers SET updated_at = now_text() WHERE id = ?').run(customerId);
  return info.lastInsertRowid;
}

async function interactions(customerId) {
  return db
    .prepare('SELECT ci.*, m.name AS "memberName" FROM customer_interactions ci LEFT JOIN members m ON m.id = ci.member_id WHERE ci.customer_id = ? ORDER BY ci.id DESC')
    .all(customerId);
}

async function followUpsDue(onOrBefore) {
  return db
    .prepare(`SELECT ci.*, c.name AS "customerName", c.phone, m.name AS "memberName" FROM customer_interactions ci JOIN customers c ON c.id = ci.customer_id LEFT JOIN members m ON m.id = ci.member_id
      WHERE ci.follow_up_on IS NOT NULL AND ci.follow_up_done = 0 AND ci.follow_up_on <= ? ORDER BY ci.follow_up_on`)
    .all(onOrBefore);
}

async function balance(customerId) {
  const row = await db
    .prepare("SELECT COALESCE(SUM(total_cents - amount_paid_cents - credited_cents), 0) AS due FROM invoices WHERE customer_id = ? AND status IN ('issued','partial')")
    .get(customerId);
  return Number(row.due);
}

module.exports = {
  get, findMatch, create, update, findOrCreate, search, properties, getProperty, addProperty, updateProperty, findOrAddProperty, propertyLine,
  EQUIPMENT_FIELDS, equipmentForCustomer, getEquipment, addEquipment, updateEquipment, CHANNELS, addInteraction, interactions, followUpsDue, balance,
};
