// Built-in website builder: permissions, editing sections, draft vs
// published, preview, publishing history, media safety, page addresses,
// theme, and that text/links typed into the builder can't inject code.
const test = require('node:test');
const assert = require('node:assert');
const { start, Client, flashOf, idFrom } = require('./helpers');

let ctx;
let db;
let gm;
let home;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ff5ccc00000000049454e44ae426082', 'hex');

test.before(async () => {
  ctx = await start({ demo: true });
  db = ctx.db;
  gm = new Client(ctx.base);
  await gm.login('gm@hvacdemo.test');
  home = await db.prepare("SELECT * FROM site_pages WHERE slug = 'home'").get();
});
test.after(async () => ctx.stop());

async function blocks(id) {
  return JSON.parse((await db.prepare('SELECT draft_json FROM site_pages WHERE id = ?').get(id)).draft_json);
}

test('only website managers can use the builder', async () => {
  for (const email of ['tech@hvacdemo.test', 'csr@hvacdemo.test', 'customer@hvacdemo.test']) {
    const c = new Client(ctx.base);
    await c.login(email);
    assert.strictEqual((await c.get('/website')).status, 403, email);
    assert.strictEqual((await c.get(`/website/preview/${home.id}`)).status, 403, email);
  }
  assert.strictEqual((await gm.get('/website')).status, 200);
  assert.strictEqual((await gm.get(`/website/pages/${home.id}`)).status, 200);
  // Starter pages are drafts: nothing public yet.
  assert.strictEqual((await new Client(ctx.base).request('GET', '/', { follow: false })).location, '/login');
  assert.strictEqual((await new Client(ctx.base).get('/services')).status, 404);
});

test('edit sections in the draft; preview shows it, the public site only after publishing', async () => {
  const add = await gm.post(`/website/pages/${home.id}/blocks`, { type: 'text', at: 1 });
  assert.match(add.url, /open=b[0-9a-f]{8}/);
  let b = await blocks(home.id);
  const text = b[1];
  assert.strictEqual(text.type, 'text');
  await gm.post(`/website/pages/${home.id}/blocks/${text.id}`, { f_heading: 'Family owned since 1984 <script>alert(1)</script>', f_body: 'First paragraph.\n\nSecond with {{company_name}}.' });
  const prev = await gm.get(`/website/preview/${home.id}`);
  assert.match(prev.text, /Family owned since 1984 &lt;script&gt;/, 'text is escaped');
  assert.doesNotMatch(prev.text, /<script>alert/);
  assert.match(prev.text, /Second with Demo Heating &amp; Air\./, 'company name token filled in');
  await gm.post(`/website/pages/${home.id}/publish`, {});
  const live = await new Client(ctx.base).get('/');
  assert.strictEqual(live.status, 200);
  assert.match(live.text, /Family owned since 1984/);
  // Further edits stay in the draft until published again.
  await gm.post(`/website/pages/${home.id}/blocks/${text.id}`, { f_heading: 'Draft only heading', f_body: '' });
  assert.doesNotMatch((await new Client(ctx.base).get('/')).text, /Draft only heading/);
  assert.match((await gm.get(`/website/preview/${home.id}`)).text, /Draft only heading/);
  // Restore the published version into the draft.
  await gm.post(`/website/pages/${home.id}/discard`, {});
  assert.strictEqual((await blocks(home.id))[1].data.heading, 'Family owned since 1984 <script>alert(1)</script>');
});

test('links are restricted to safe destinations', async () => {
  const b = await blocks(home.id);
  const hero = b.find((x) => x.type === 'hero');
  await gm.post(`/website/pages/${home.id}/blocks/${hero.id}`, { f_heading: 'Hello', f_button1_label: 'Bad', f_button1_link: 'javascript:alert(1)', f_button2_label: 'Call', f_button2_link: 'tel:5550102000', f_align: 'left', f_overlay: '50' });
  const after = (await blocks(home.id)).find((x) => x.id === hero.id);
  assert.strictEqual(after.data.button1_link, '');
  assert.strictEqual(after.data.button2_link, 'tel:5550102000');
  assert.doesNotMatch((await gm.get(`/website/preview/${home.id}`)).text, /javascript:alert/);
});

test('reorder, duplicate, move and delete sections; items in repeating sections', async () => {
  const ids = (await blocks(home.id)).map((x) => x.id);
  const reversed = ids.slice().reverse();
  const r = await fetch(`${ctx.base}/website/pages/${home.id}/order`, { method: 'POST', headers: { cookie: gm.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' }, body: reversed.map((i) => 'ids=' + i).join('&') });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await blocks(home.id)).map((x) => x.id), reversed);
  const bad = await fetch(`${ctx.base}/website/pages/${home.id}/order`, { method: 'POST', headers: { cookie: gm.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'ids=nope' });
  assert.strictEqual(bad.status, 400);
  const svc = (await blocks(home.id)).find((x) => x.type === 'services');
  await gm.post(`/website/pages/${home.id}/blocks/${svc.id}/duplicate`, {});
  assert.strictEqual((await blocks(home.id)).filter((x) => x.type === 'services').length, 2);
  const n = svc.data.items.length;
  await gm.post(`/website/pages/${home.id}/blocks/${svc.id}`, { f_heading: 'Services', i0_remove: '1', ...Object.fromEntries(svc.data.items.slice(1).flatMap((it, k) => [[`i${k + 1}_title`, it.title], [`i${k + 1}_text`, it.text]])), [`i${n}_title`]: 'Indoor Air Quality', [`i${n}_text`]: 'Purifiers and humidifiers.' });
  const items = (await blocks(home.id)).find((x) => x.id === svc.id).data.items;
  assert.strictEqual(items.length, n);
  assert.strictEqual(items[items.length - 1].title, 'Indoor Air Quality');
  const dup = (await blocks(home.id)).filter((x) => x.type === 'services')[1];
  await gm.post(`/website/pages/${home.id}/blocks/${dup.id}/delete`, {});
  assert.strictEqual((await blocks(home.id)).filter((x) => x.type === 'services').length, 1);
  const first = (await blocks(home.id))[1].id;
  await gm.post(`/website/pages/${home.id}/blocks/${first}/up`, {});
  assert.strictEqual((await blocks(home.id))[0].id, first);
});

test('pages: create, reserved addresses refused, menu, publish/hide, version history', async () => {
  assert.match(flashOf(await gm.post('/website/pages', { title: 'Jobs', slug: 'jobs' })), /used by the business system/);
  const r = await gm.post('/website/pages', { title: 'Heat Pumps', template: 'basic' });
  const id = idFrom(r.url, '/website/pages');
  assert.ok(id);
  assert.match(flashOf(await gm.post('/website/pages', { title: 'Heat Pumps' })), /already exists/);
  await gm.post(`/website/pages/${id}/publish`, {});
  const pageRes = await new Client(ctx.base).get('/heat-pumps');
  assert.strictEqual(pageRes.status, 200);
  assert.match((await new Client(ctx.base).get('/')).text, /href="\/heat-pumps"/, 'shown in the menu');
  await gm.post(`/website/pages/${id}/settings`, { title: 'Heat Pumps', slug: 'heat-pumps', nav_label: 'Heat Pumps', seo_title: 'Heat pump installs', seo_description: 'Efficient heating and cooling.' });
  assert.doesNotMatch((await new Client(ctx.base).get('/')).text, /href="\/heat-pumps"/, 'menu checkbox unticked');
  assert.match((await new Client(ctx.base).get('/heat-pumps')).text, /<title>Heat pump installs<\/title>/);
  await gm.post(`/website/pages/${id}/unpublish`, {});
  assert.strictEqual((await new Client(ctx.base).get('/heat-pumps')).status, 404);
  const revs = await db.prepare('SELECT id FROM site_revisions WHERE page_id = ? ORDER BY id').all(home.id);
  assert.ok(revs.length >= 1);
  await gm.post(`/website/pages/${home.id}/restore/${revs[0].id}`, {});
  assert.match(flashOf(await gm.post(`/website/pages/${home.id}/delete`, {})), /can't be deleted/);
  // App routes always win over page addresses.
  assert.strictEqual((await new Client(ctx.base).request('GET', '/jobs', { follow: false })).status, 302);
});

test('media: only real images, served publicly, protected while in use; theme applies', async () => {
  const up = (name, type, buf) => {
    const fd = new FormData();
    fd.append('images', new Blob([buf], { type }), name);
    return fetch(`${ctx.base}/website/media`, { method: 'POST', body: fd, headers: { cookie: gm.cookieHeader() }, redirect: 'manual' });
  };
  const svg = await up('x.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  assert.match(decodeURIComponent(svg.headers.get('location')), /PNG, JPG, GIF or WebP/);
  const fake = await up('fake.png', 'image/png', Buffer.from('not an image'));
  assert.match(decodeURIComponent(fake.headers.get('location')), /PNG, JPG/);
  await up('truck.png', 'image/png', PNG);
  const m = await db.prepare("SELECT id, mime_type FROM site_media WHERE file_name = 'truck.png'").get();
  assert.strictEqual(m.mime_type, 'image/png');
  const img = await fetch(`${ctx.base}/media/${m.id}`);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  const hero = (await blocks(home.id)).find((x) => x.type === 'hero');
  await gm.post(`/website/pages/${home.id}/blocks/${hero.id}`, { f_heading: 'With photo', f_image: String(m.id), f_align: 'center', f_overlay: '70' });
  assert.match(flashOf(await gm.post(`/website/media/${m.id}/delete`, {})), /used on: Home/);
  await gm.post('/website/theme', { site_primary_color: '#123456', site_accent_color: 'red; } body { display:none', site_font: 'classic', site_header_cta_label: 'Book now', site_header_cta_link: '/request-service', site_show_staff_login: '1' });
  await gm.post(`/website/pages/${home.id}/publish`, {});
  const live = (await new Client(ctx.base).get('/')).text;
  assert.match(live, /--primary: #123456/);
  assert.match(live, /--accent: #e8590c/, 'invalid color ignored');
  assert.match(live, /background-image:url\(\/media\/\d+\)/);
  assert.match(live, />Book now</);
  // Hiding the home page takes the site offline again.
  await gm.post(`/website/pages/${home.id}/unpublish`, {});
  assert.strictEqual((await new Client(ctx.base).request('GET', '/', { follow: false })).location, '/login');
});
