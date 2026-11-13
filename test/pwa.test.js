// Installable app (PWA): manifest, icons, service worker and offline page
// are reachable without logging in, and every page links them.
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

let ctx;
test.before(async () => { ctx = await start({ demo: false }); });
test.after(async () => ctx.stop());

test('manifest describes an installable app named after the company', async () => {
  const res = await fetch(ctx.base + '/manifest.webmanifest');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const m = await res.json();
  assert.ok(m.name && m.short_name);
  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.scope, '/');
  for (const size of ['192x192', '512x512']) assert.ok(m.icons.some((i) => i.sizes === size), size);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));

  await require('../utils/settings').set('company_name', 'Acme Heating & Air');
  const named = await (await fetch(ctx.base + '/manifest.webmanifest')).json();
  assert.strictEqual(named.name, 'Acme Heating & Air');
  assert.ok(named.short_name.length <= 12);
});

test('icons, service worker and offline page are served', async () => {
  for (const url of ['/sw.js', '/offline.html', '/js/pwa.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-64.png']) {
    const res = await fetch(ctx.base + url);
    assert.strictEqual(res.status, 200, url);
  }
  const sw = await (await fetch(ctx.base + '/sw.js')).text();
  for (const asset of sw.match(/'\/[^']+'/g).map((s) => s.slice(1, -1))) {
    assert.strictEqual((await fetch(ctx.base + asset)).status, 200, 'precached ' + asset);
  }
});

test('pages link the manifest, icons and install script', async () => {
  const html = await (await fetch(ctx.base + '/login')).text();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /src="\/js\/pwa\.js"/);
});
