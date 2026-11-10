// Service requests: everything a customer asks for (service call,
// estimate, maintenance, emergency, warranty, complaint) before it
// becomes a scheduled job. intake() is shared by the office form and
// the public website's request forms (and the customer portal):
//   1. find-or-create the customer (dedupe on email / phone)
//   2. save the service address as a property (deduped)
//   3. create the request with a unique SR- number
//   4. notify customer service, 5. queue the customer confirmation
// An optional external_id makes repeated submissions of the same form safe.
const db = require('../db');
const fmt = require('./format');
const customers = require('./customers');
const jobs = require('./jobs');
const automation = require('./automation');
const messaging = require('./messaging');
const settings = require('./settings');

const KINDS = ['service', 'estimate', 'maintenance', 'emergency', 'warranty', 'complaint'];
const STATUSES = ['new', 'contacted', 'converted', 'closed'];

async function get(id) {
  return db
    .prepare(`SELECT sr.*, c.name AS "customerName", c.phone AS "customerPhone", c.email AS "customerEmail", c.customer_number, p.address, p.city, p.state, p.zip, j.job_number, m.name AS "createdByName"
      FROM service_requests sr JOIN customers c ON c.id = sr.customer_id LEFT JOIN properties p ON p.id = sr.property_id LEFT JOIN jobs j ON j.id = sr.job_id LEFT JOIN members m ON m.id = sr.created_by WHERE sr.id = ?`)
    .get(id);
}

async function list({ status = null, open = false, customerId = null, limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('sr.status = ?'); params.push(status); }
  if (open) where.push("sr.status IN ('new','contacted')");
  if (customerId) { where.push('sr.customer_id = ?'); params.push(customerId); }
  const max = Math.min(parseInt(limit, 10) || 300, 2000);
  return db
    .prepare(`SELECT sr.*, c.name AS "customerName", c.phone AS "customerPhone", p.address, j.job_number FROM service_requests sr JOIN customers c ON c.id = sr.customer_id LEFT JOIN properties p ON p.id = sr.property_id LEFT JOIN jobs j ON j.id = sr.job_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE WHEN sr.kind = 'emergency' AND sr.status IN ('new','contacted') THEN 0 ELSE 1 END, sr.id DESC LIMIT ${max}`)
    .all(...params);
}

// data: { name, email, phone, account_type, company_name, address, city, state, zip, kind, description, preferred_date, preferred_time, source, external_id, customer_id? }
async function intake(data, { memberId = null } = {}) {
  const externalId = fmt.clean(data.external_id, 200);
  if (externalId) {
    const dup = await db.prepare('SELECT id FROM service_requests WHERE external_id = ?').get(externalId);
    if (dup) return { request: await get(dup.id), duplicate: true, customerCreated: false };
  }
  const kind = KINDS.includes(data.kind) ? data.kind : 'service';
  const result = await db.withTransaction(async (tx) => {
    let customer;
    let created = false;
    if (data.customer_id) {
      customer = await tx.prepare('SELECT * FROM customers WHERE id = ?').get(data.customer_id);
      if (!customer) throw new Error('Customer not found.');
    } else {
      if (!fmt.clean(data.name)) throw new Error('Name is required.');
      if (!fmt.clean(data.email) && !fmt.clean(data.phone)) throw new Error('An email address or phone number is required.');
      ({ customer, created } = await customers.findOrCreate({ ...data, source: data.source || 'office' }, memberId, tx));
    }
    const propertyId = data.property_id || (await customers.findOrAddProperty(customer.id, data, tx));
    const info = await tx
      .prepare('INSERT INTO service_requests (customer_id, property_id, kind, description, preferred_date, preferred_time, source, external_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(customer.id, propertyId || null, kind, fmt.clean(data.description, 5000), fmt.dateOnly(data.preferred_date), fmt.clean(data.preferred_time, 50), fmt.clean(data.source, 40) || 'office', externalId, memberId);
    const id = info.lastInsertRowid;
    await tx.prepare('UPDATE service_requests SET request_number = ? WHERE id = ?').run(fmt.number('SR', id), id);
    await customers.addInteraction(customer.id, { channel: ['website', 'portal'].includes(data.source) ? 'web' : 'note', direction: 'inbound', summary: `Service request ${fmt.number('SR', id)} (${kind}): ${fmt.clean(data.description, 500) || 'no details'}` }, memberId, tx);
    return { id, customer, created };
  });
  const request = await get(result.id);

  await automation.run('automation_notify_new_request', 'service_request', request.id, async () => {
    const n = await automation.notifyPermission(['requests.manage'], 'service_request', {
      title: `${kind === 'emergency' ? 'EMERGENCY ' : ''}Service request ${request.request_number}`,
      body: `${request.customerName}: ${fmt.label(kind)}${request.address ? ' at ' + request.address : ''}`,
      linkUrl: `/requests/${request.id}`,
    }, memberId);
    return `notified ${n} people`;
  });
  await automation.run('automation_customer_request_confirmation', 'service_request', request.id, async () => {
    const company = await settings.get('company_name', 'our team');
    const phone = await settings.get('company_phone', '');
    const body = `Hi ${request.customerName}, ${company} received your ${fmt.label(kind).toLowerCase()} request (${request.request_number}). We'll contact you shortly to schedule.${phone ? ' Questions or emergencies: ' + phone : ''}`;
    const results = [];
    if (request.customerEmail) results.push(await messaging.send({ channel: 'email', to: request.customerEmail, subject: `We received your request ${request.request_number}`, body, relatedType: 'service_request', relatedId: request.id }));
    if (request.customerPhone) results.push(await messaging.send({ channel: 'sms', to: request.customerPhone, body, relatedType: 'service_request', relatedId: request.id }));
    return results.map((r) => r && r.status).join(', ') || 'no contact info';
  });
  return { request, duplicate: false, customerCreated: result.created };
}

async function setStatus(id, status) {
  if (!STATUSES.includes(status) || status === 'converted') throw new Error('Invalid status.');
  await db.prepare('UPDATE service_requests SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
}

const KIND_TO_JOB = { service: ['service', 'ready_to_schedule'], estimate: ['estimate', 'estimate_requested'], maintenance: ['maintenance', 'ready_to_schedule'], emergency: ['emergency', 'ready_to_schedule'], warranty: ['warranty', 'ready_to_schedule'], complaint: ['service', 'ready_to_schedule'] };

async function convertToJob(id, memberId, overrides = {}) {
  return db.withTransaction(async (tx) => {
    const sr = await tx.prepare('SELECT * FROM service_requests WHERE id = ?').get(id);
    if (!sr) throw new Error('Request not found.');
    if (sr.job_id) throw new Error('This request already has a job.');
    const [jobType, status] = KIND_TO_JOB[sr.kind] || ['service', 'ready_to_schedule'];
    const jobId = await jobs.create({
      customer_id: sr.customer_id, property_id: sr.property_id, service_request_id: sr.id,
      title: fmt.clean(overrides.title, 200) || `${fmt.label(sr.kind)} request ${sr.request_number}`,
      description: sr.description, job_type: jobType, priority: sr.kind === 'emergency' ? 'emergency' : 'normal', status,
    }, memberId, tx);
    await tx.prepare("UPDATE service_requests SET status = 'converted', job_id = ?, updated_at = now_text() WHERE id = ?").run(jobId, id);
    return jobId;
  });
}

module.exports = { KINDS, STATUSES, get, list, intake, setStatus, convertToJob };
