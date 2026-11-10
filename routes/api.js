// Machine-to-machine API. Currently: the Wix website integration.
//
// POST /api/integrations/wix/service-request
//   Authorization: Bearer <WIX_WEBHOOK_SECRET>
//   JSON body (see docs/WIX_INTEGRATION.md):
//   { name, email, phone, address, city, state, zip, requestType,
//     message, preferredDate, preferredTime, accountType, companyName,
//     submissionId }
//
// The secret lives only in this server's environment and in Wix's
// Secrets Manager (called from Wix backend code) - never in browser code.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const serviceRequests = require('../utils/serviceRequests');
const audit = require('../utils/audit');

// Best-effort per-instance throttle (serverless instances each keep
// their own counters; the shared secret is the real protection).
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 30;
}

function secretOk(req) {
  const expected = process.env.WIX_WEBHOOK_SECRET;
  if (!expected) return null;
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-webhook-secret') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const TYPE_MAP = {
  service: 'service', repair: 'service', 'service call': 'service', 'request service': 'service', 'schedule service': 'service',
  estimate: 'estimate', quote: 'estimate', 'request an estimate': 'estimate', installation: 'estimate', replacement: 'estimate',
  maintenance: 'maintenance', tuneup: 'maintenance', 'tune-up': 'maintenance', 'maintenance plan': 'maintenance',
  emergency: 'emergency', 'emergency service': 'emergency', warranty: 'warranty', complaint: 'complaint',
};

function pick(body, ...keys) {
  for (const k of keys) if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') return String(body[k]).slice(0, 5000);
  return null;
}

router.get('/health', (req, res) => res.json({ ok: true }));

router.post('/integrations/wix/service-request', async (req, res) => {
  const ip = req.get('x-forwarded-for') ? req.get('x-forwarded-for').split(',')[0].trim() : req.ip;
  if (throttled(ip)) return res.status(429).json({ ok: false, error: 'Too many requests.' });
  const ok = secretOk(req);
  if (ok === null) return res.status(503).json({ ok: false, error: 'Wix integration is not configured on the server (WIX_WEBHOOK_SECRET is not set).' });
  if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorized.' });

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  // Hidden "website" field on the form: real people leave it blank.
  if (pick(b, 'website', 'hp')) return res.status(202).json({ ok: true, ignored: true });
  const rawType = (pick(b, 'requestType', 'request_type', 'kind', 'type') || 'service').toLowerCase();
  const data = {
    name: pick(b, 'name', 'fullName', 'full_name') || [pick(b, 'firstName', 'first_name'), pick(b, 'lastName', 'last_name')].filter(Boolean).join(' '),
    email: pick(b, 'email'),
    phone: pick(b, 'phone', 'phoneNumber', 'phone_number'),
    account_type: (pick(b, 'accountType', 'account_type') || '').toLowerCase() === 'commercial' ? 'commercial' : 'residential',
    company_name: pick(b, 'companyName', 'company_name', 'company'),
    address: pick(b, 'address', 'street', 'serviceAddress'),
    city: pick(b, 'city'),
    state: pick(b, 'state'),
    zip: pick(b, 'zip', 'zipCode', 'postalCode'),
    kind: TYPE_MAP[rawType] || (serviceRequests.KINDS.includes(rawType) ? rawType : 'service'),
    description: pick(b, 'message', 'description', 'details'),
    preferred_date: pick(b, 'preferredDate', 'preferred_date'),
    preferred_time: pick(b, 'preferredTime', 'preferred_time'),
    external_id: pick(b, 'submissionId', 'submission_id', 'id') ? 'wix:' + pick(b, 'submissionId', 'submission_id', 'id') : null,
    source: 'wix',
  };
  try {
    const { request, duplicate, customerCreated } = await serviceRequests.intake(data);
    if (!duplicate) await audit.log({ headers: req.headers, ip }, 'service_request.wix', 'service_request', request.id, { customerCreated });
    res.status(duplicate ? 200 : 201).json({ ok: true, requestNumber: request.request_number, duplicate });
  } catch (err) {
    if (err.code) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Could not save the request.' });
    }
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
