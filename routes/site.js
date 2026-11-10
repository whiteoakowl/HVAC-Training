// Public company website built with the website builder (/website).
//   /                  home page (once published; otherwise the staff login)
//   /<page-slug>       any other published page
//   /media/:id         images from the media library
//   POST /site/request service request form -> Service Requests
// Mounted after every business route, so app URLs always win; page
// addresses that would collide are refused by the builder.
const express = require('express');
const router = express.Router();
const site = require('../utils/site');
const serviceRequests = require('../utils/serviceRequests');
const audit = require('../utils/audit');

async function renderPage(req, res, page, blocks, { preview = false } = {}) {
  const t = await site.theme();
  res.render('site/page', {
    layout: false, page, blocks, t, nav: await site.nav(), preview, fill: (s) => site.fill(s, t), BLOCKS: site.BLOCKS,
    sent: req.query.sent === '1', formError: typeof req.query.form_error === 'string' ? req.query.form_error.slice(0, 200) : null,
    requestType: ['service', 'estimate', 'maintenance', 'emergency'].includes(req.query.type) ? req.query.type : null, path: req.path,
  });
}

router.get('/', async (req, res, next) => {
  const home = await site.getPublishedBySlug('home');
  if (!home) return res.redirect(req.member ? res.locals.homeHref : '/login');
  await renderPage(req, res, home, JSON.parse(home.published_json));
  void next;
});

router.get('/media/:id', async (req, res) => {
  const m = await site.getMedia(req.params.id);
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(m.mime_type).send(Buffer.from(m.content));
});

// Best-effort throttle per server instance.
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 600000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 8;
}

router.post('/site/request', async (req, res) => {
  const back = site.cleanLink(req.body.return_to) || '/';
  const go = (q) => res.redirect(`${back.split('#')[0].split('?')[0]}?${q}#request-form`);
  // Hidden "website" field: people leave it blank, bots fill it in.
  if (req.body.website) return go('sent=1');
  const ip = req.ip;
  if (throttled(ip)) return go('form_error=' + encodeURIComponent('Too many requests from this connection. Please call us instead.'));
  try {
    const { request, customerCreated } = await serviceRequests.intake({
      name: req.body.name, email: req.body.email, phone: req.body.phone, address: req.body.address, city: req.body.city, state: req.body.state, zip: req.body.zip,
      account_type: req.body.account_type === 'commercial' ? 'commercial' : 'residential', company_name: req.body.company_name,
      kind: ['service', 'estimate', 'maintenance', 'emergency'].includes(req.body.kind) ? req.body.kind : 'service',
      description: req.body.description, preferred_date: req.body.preferred_date, preferred_time: req.body.preferred_time, source: 'website',
    });
    await audit.log({ headers: req.headers, ip }, 'service_request.website', 'service_request', request.id, { customerCreated, page: back });
    go('sent=1&ref=' + encodeURIComponent(request.request_number));
  } catch (err) {
    go('form_error=' + encodeURIComponent(err.code ? 'Something went wrong. Please call us.' : err.message));
  }
});

// Any other published page. Must stay the last route before the 404.
router.get('/:slug', async (req, res, next) => {
  if (!/^[a-z0-9-]{1,60}$/.test(req.params.slug) || site.RESERVED.has(req.params.slug) || req.params.slug === 'home') return next();
  const page = await site.getPublishedBySlug(req.params.slug);
  if (!page) return next();
  await renderPage(req, res, page, JSON.parse(page.published_json));
});

module.exports = router;
module.exports.renderPage = renderPage;
