// Meetings (calendar/list, join video), Documents tab and team
// checklists in the employee and management portals.
const test = require('node:test');
const assert = require('node:assert');
const { start, Client, flashOf, idFrom } = require('./helpers');

let ctx;
let db;
let fmt;
let today;
const ids = {};

test.before(async () => {
  ctx = await start({ demo: true });
  db = ctx.db;
  fmt = require('../utils/format');
  await require('../utils/settings').applyTimezone(true);
  today = fmt.today();
});
test.after(async () => ctx.stop());

async function as(email) {
  const c = new Client(ctx.base);
  await c.login(email);
  return c;
}
async function memberId(email) {
  return (await db.prepare('SELECT id FROM members WHERE email = ?').get(email)).id;
}

test('employees and managers have Meetings, Documents and Checklists tabs', async () => {
  const tech = await as('tech@hvacdemo.test');
  const home = await tech.get('/employee');
  for (const href of ['/meetings', '/documents', '/checklists', '/training/mine']) assert.match(home.text, new RegExp(`href="${href}"`), href);
  assert.doesNotMatch(home.text, /href="\/meetings\/manage"|href="\/checklists\/manage"/, 'no management links for techs');
  for (const url of ['/meetings', '/meetings?view=calendar', '/documents', '/checklists']) assert.strictEqual((await tech.get(url)).status, 200, url);
  for (const url of ['/meetings/manage', '/meetings/new', '/checklists/manage', '/checklists/new', '/documents/manage']) assert.strictEqual((await tech.get(url)).status, 403, url);

  for (const email of ['gm@hvacdemo.test', 'office@hvacdemo.test', 'servicemgr@hvacdemo.test']) {
    const m = await as(email);
    const page = await m.get('/meetings/manage');
    assert.strictEqual(page.status, 200, email);
    for (const href of ['/meetings/manage', '/documents/manage', '/checklists/manage', '/training/manage']) assert.match(page.text, new RegExp(`href="${href}"`), `${email} ${href}`);
    for (const url of ['/meetings/new', '/checklists/manage', '/checklists/new', '/documents/manage']) assert.strictEqual((await m.get(url)).status, 200, `${email} ${url}`);
  }
  // Customers get none of it.
  const cust = await as('customer@hvacdemo.test');
  for (const url of ['/meetings', '/checklists', '/documents']) assert.strictEqual((await cust.get(url)).status, 403, url);
});

test('schedule a meeting: invitees see it in list and calendar, get notified, and join the video call', async () => {
  const mgr = await as('servicemgr@hvacdemo.test');
  const startAt = `${fmt.addDays(today, 2)}T10:30`;
  const r = await mgr.post('/meetings', { title: 'Tech huddle', description: 'Callbacks review', starts_at: startAt, duration_minutes: 45, audience: 'role', audience_role: 'technician', video_kind: 'builtin' });
  assert.match(flashOf(r), /scheduled/);
  ids.meeting = idFrom(r.url, '/meetings');
  const m = await db.prepare('SELECT * FROM meetings WHERE id = ?').get(ids.meeting);
  assert.strictEqual(m.starts_at, `${fmt.addDays(today, 2)} 10:30:00`);
  assert.match(m.room_key, /^[0-9a-f]{24}$/);

  const tech = await as('tech@hvacdemo.test');
  const list = await tech.get('/meetings');
  assert.match(list.text, /Tech huddle/);
  assert.match(list.text, /10:30 AM–11:15 AM/);
  const cal = await tech.get(`/meetings?view=calendar&month=${fmt.addDays(today, 2).slice(0, 7)}`);
  assert.match(cal.text, /class="cal-item[^"]*" href="\/meetings\/\d+">10:30 AM Tech huddle/);
  const note = await db.prepare("SELECT * FROM notifications WHERE member_id = ? AND type_key = 'meeting'").get(await memberId('tech@hvacdemo.test'));
  assert.ok(note && /Tech huddle/.test(note.title), 'technician notified');

  const detail = await tech.get(`/meetings/${ids.meeting}`);
  assert.match(detail.text, /Join video call/);
  assert.match(detail.text, /Technician only/);
  const join = await tech.get(`/meetings/${ids.meeting}/join`, { follow: false });
  assert.strictEqual(join.status, 302);
  assert.strictEqual(join.location, `https://meet.jit.si/HVAC-${m.room_key}`);

  // Not invited: the installer can't see or join it.
  const inst = await as('installer@hvacdemo.test');
  assert.doesNotMatch((await inst.get('/meetings')).text, /Tech huddle/);
  assert.strictEqual((await inst.get(`/meetings/${ids.meeting}`)).status, 404);
  assert.strictEqual((await inst.get(`/meetings/${ids.meeting}/join`, { follow: false })).status, 404);
});

test('own video link, specific people, moving and cancelling a meeting', async () => {
  const gm = await as('gm@hvacdemo.test');
  const lead = await memberId('lead@hvacdemo.test');
  const base = { title: 'Owner check-in', starts_at: `${fmt.addDays(today, 1)}T09:00`, duration_minutes: 30, audience: 'people', people: [lead], video_kind: 'link' };
  assert.match(flashOf(await gm.post('/meetings', { ...base, video_url: 'javascript:alert(1)' })), /https:\/\//, 'only https links');
  assert.match(flashOf(await gm.post('/meetings', { ...base, people: [], video_url: 'https://zoom.us/j/123' })), /at least one person/);
  const r = await gm.post('/meetings', { ...base, video_url: 'https://zoom.us/j/123456789' });
  const id = idFrom(r.url, '/meetings');
  const leadC = await as('lead@hvacdemo.test');
  assert.strictEqual((await leadC.get(`/meetings/${id}/join`, { follow: false })).location, 'https://zoom.us/j/123456789');
  assert.match((await leadC.get('/employee')).text, /Next meetings[\s\S]*Owner check-in/, 'shows on My Day');
  const tech = await as('tech@hvacdemo.test');
  assert.strictEqual((await tech.get(`/meetings/${id}`)).status, 404);

  // Move it: invitees are told.
  const moved = await gm.post(`/meetings/${id}`, { ...base, starts_at: `${fmt.addDays(today, 2)}T08:15`, video_url: 'https://zoom.us/j/123456789' });
  assert.match(flashOf(moved), /new time/);
  assert.ok(await db.prepare("SELECT id FROM notifications WHERE member_id = ? AND title LIKE 'Meeting moved%'").get(lead));
  // Cancel it.
  assert.match(flashOf(await gm.post(`/meetings/${id}/cancel`, {})), /cancelled/);
  assert.ok(await db.prepare("SELECT id FROM notifications WHERE member_id = ? AND title LIKE 'Meeting cancelled%'").get(lead));
  assert.match(flashOf(await leadC.get(`/meetings/${id}/join`)), /cancelled/);
  assert.doesNotMatch((await leadC.get('/employee')).text, /Owner check-in/);
  // Technicians can't schedule.
  assert.strictEqual((await tech.post('/meetings', base)).status, 403);
});

test('in-person meetings and the video server setting', async () => {
  const admin = await as('admin@hvactraining.test');
  const s = await admin.get('/admin/settings');
  assert.match(s.text, /name="meeting_video_domain" value="meet\.jit\.si"/);
  const r = await admin.post('/meetings', { title: 'Shop cleanup', starts_at: `${fmt.addDays(today, 3)}T15:00`, duration_minutes: 60, audience: 'all', video_kind: 'none', location: 'Warehouse' });
  const id = idFrom(r.url, '/meetings');
  const page = await admin.get(`/meetings/${id}`);
  assert.match(page.text, /In-person meeting/);
  assert.match(page.text, /Warehouse/);
  assert.match(flashOf(await admin.get(`/meetings/${id}/join`)), /in person/);
  // Everyone on staff can see an "all staff" meeting.
  assert.match((await (await as('csr@hvacdemo.test')).get('/meetings')).text, /Shop cleanup/);
});

test('checklists: managers create by topic, people tick their own boxes, managers see who finished', async () => {
  const mgr = await as('office@hvacdemo.test');
  assert.match(flashOf(await mgr.post('/checklists', { title: 'Empty', items: '  \n ', audience: 'all' })), /at least one item/);
  const r = await mgr.post('/checklists', {
    title: 'Truck morning check', topic: 'Safety', description: 'Before leaving the shop', due_date: fmt.addDays(today, 7),
    items: 'Tires and lights\nFire extinguisher charged\nLadder secured', audience: 'role', audience_role: 'technician',
  });
  assert.match(flashOf(r), /created/);
  const id = idFrom(r.url, '/checklists');
  ids.checklist = id;
  const items = await db.prepare('SELECT * FROM team_checklist_items WHERE checklist_id = ? ORDER BY position').all(id);
  assert.deepStrictEqual(items.map((i) => i.label), ['Tires and lights', 'Fire extinguisher charged', 'Ladder secured']);
  const techId = await memberId('tech@hvacdemo.test');
  assert.ok(await db.prepare("SELECT id FROM notifications WHERE member_id = ? AND type_key = 'checklist'").get(techId));

  const tech = await as('tech@hvacdemo.test');
  const mine = await tech.get('/checklists');
  assert.match(mine.text, /Truck morning check/);
  assert.match(mine.text, /0 of 3 done/);
  const page = await tech.get(`/checklists/${id}`);
  assert.strictEqual((page.text.match(/type="checkbox" name="item"/g) || []).length, 3);
  assert.match(flashOf(await tech.post(`/checklists/${id}/check`, { item: [items[0].id, items[2].id] })), /2 of 3/);
  assert.match((await tech.get('/checklists')).text, /2 of 3 done/);
  // Unticking works; ticks on another list's items are ignored.
  assert.match(flashOf(await tech.post(`/checklists/${id}/check`, { item: [items[0].id, items[1].id, items[2].id, 99999] })), /All done/);
  assert.match(flashOf(await tech.post(`/checklists/${id}/check`, { item: [items[1].id, items[2].id] })), /2 of 3/);

  // Not for installers.
  const inst = await as('installer@hvacdemo.test');
  assert.doesNotMatch((await inst.get('/checklists')).text, /Truck morning check/);
  assert.strictEqual((await inst.get(`/checklists/${id}`)).status, 404);
  assert.match(flashOf(await inst.post(`/checklists/${id}/check`, { item: [items[0].id] })), /not assigned/);

  // Manager's board.
  const board = await mgr.get(`/checklists/${id}`);
  assert.match(board.text, /Who's done/);
  assert.match(board.text, /Tom Technician|<td>[^<]*<\/td>\s*<td><span class="status status-in_progress">2\/3/);
  const overview = await mgr.get('/checklists/manage');
  assert.match(overview.text, /Truck morning check[\s\S]*Safety[\s\S]*Technician only/);

  // Editing keeps ticks on unchanged items.
  await mgr.post(`/checklists/${id}`, { title: 'Truck morning check', topic: 'Safety', items: 'Tires and lights\nLadder secured\nFirst-aid kit stocked', audience: 'role', audience_role: 'technician' });
  const kept = await db.prepare('SELECT i.label FROM team_checklist_checks c JOIN team_checklist_items i ON i.id = c.item_id WHERE c.checklist_id = ? AND c.member_id = ?').all(id, techId);
  assert.deepStrictEqual(kept.map((k) => k.label), ['Ladder secured']);
  assert.match((await tech.get('/checklists')).text, /1 of 3 done/);

  // Archive hides it from employees but keeps the history.
  await mgr.post(`/checklists/${id}/archive`, {});
  assert.doesNotMatch((await tech.get('/checklists')).text, /Truck morning check/);
  assert.strictEqual((await tech.get(`/checklists/${id}`)).status, 404);
  assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM team_checklist_checks WHERE checklist_id = ?').get(id)).c, 1);
  await mgr.post(`/checklists/${id}/archive`, {});
  assert.match((await tech.get('/checklists')).text, /Truck morning check/);

  // Technicians can't create checklists.
  assert.strictEqual((await tech.post('/checklists', { title: 'x', items: 'y', audience: 'all' })).status, 403);
});

test('checklists for specific people', async () => {
  const gm = await as('gm@hvacdemo.test');
  const csr = await memberId('csr@hvacdemo.test');
  const r = await gm.post('/checklists', { title: 'Phone script review', topic: 'Customer service', items: 'Greeting\nMembership upsell', audience: 'people', people: [csr] });
  const id = idFrom(r.url, '/checklists');
  assert.match((await (await as('csr@hvacdemo.test')).get('/checklists')).text, /Phone script review/);
  assert.strictEqual((await (await as('dispatch@hvacdemo.test')).get(`/checklists/${id}`)).status, 404);
});
