// Every role: log in, open every navigation link, then every internal
// link found on those pages. Nothing may 500, nav links must all load,
// and no page may link to a 404.
const test = require('node:test');
const assert = require('node:assert');
const { start, Client } = require('./helpers');

const USERS = [
  'admin@hvactraining.test', 'instructor@hvactraining.test', 'student@hvactraining.test',
  'gm@hvacdemo.test', 'office@hvacdemo.test', 'accounting@hvacdemo.test', 'csr@hvacdemo.test', 'dispatch@hvacdemo.test',
  'servicemgr@hvacdemo.test', 'lead@hvacdemo.test', 'tech@hvacdemo.test', 'installer@hvacdemo.test', 'warehouse@hvacdemo.test', 'customer@hvacdemo.test',
];

function links(html, re = /href="(\/[^"#]*)"/g) {
  const out = new Set();
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].replace(/&amp;/g, '&');
    if (href.startsWith('//') || href.startsWith('/css') || href.startsWith('/js') || href.includes('format=csv')) continue;
    out.add(href);
  }
  return [...out];
}

let ctx;
test.before(async () => {
  ctx = await start({ demo: true });
});
test.after(async () => ctx.stop());

for (const email of USERS) {
  test(`every page reachable by ${email} renders`, async () => {
    const c = new Client(ctx.base);
    const home = await c.login(email);
    assert.strictEqual(home.status, 200, `home for ${email}`);
    const sidebar = (home.text.match(/<aside class="app-sidebar"[\s\S]*?<\/aside>/) || [''])[0];
    const nav = links(sidebar);
    assert.ok(nav.length >= 2, 'has navigation');
    const seen = new Set();
    const second = new Set();
    for (const href of nav) {
      const r = await c.get(href);
      seen.add(href);
      assert.strictEqual(r.status, 200, `${email}: nav link ${href} returned ${r.status}`);
      for (const l of links(r.text)) second.add(l);
    }
    for (const href of second) {
      if (seen.has(href)) continue;
      seen.add(href);
      const r = await c.get(href);
      assert.notStrictEqual(r.status, 500, `${email}: ${href} returned 500`);
      assert.notStrictEqual(r.status, 404, `${email}: ${href} is a broken link`);
      assert.notStrictEqual(r.status, 403, `${email}: ${href} is linked but forbidden`);
    }
  });
}
