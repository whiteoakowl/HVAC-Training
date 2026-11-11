// Checklists tab (employee + management portals). Managers create
// checklists by topic (onboarding, safety, truck inspection, opening the
// shop...) and choose who they're for. Each person ticks their own boxes;
// managers see who has finished. (Job inspection forms are separate:
// Admin -> Job Checklists.)
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const permissions = require('../utils/permissions');
const notifications = require('../utils/notifications');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action, asArray } = require('../utils/http');

router.use('/checklists', requireAuth, requirePermission('team_checklists.use', 'team_checklists.manage'));

const SELECT = 'SELECT l.*, r.name AS "roleName", c.name AS "createdByName" FROM team_checklists l LEFT JOIN roles r ON r.key = l.audience_role LEFT JOIN members c ON c.id = l.created_by';
const FOR_ME = "(l.audience = 'all' OR (l.audience = 'role' AND l.audience_role = ?) OR EXISTS (SELECT 1 FROM team_checklist_people p WHERE p.checklist_id = l.id AND p.member_id = ?))";

async function staff() {
  return permissions.membersWith('team_checklists.use', 'team_checklists.manage');
}

// Everyone a checklist is for.
async function audienceOf(l) {
  if (l.audience === 'people') return db.prepare('SELECT m.id, m.name, m.role FROM team_checklist_people p JOIN members m ON m.id = p.member_id WHERE p.checklist_id = ? AND m.active = 1 ORDER BY m.name').all(l.id);
  return (await staff()).filter((s) => l.audience === 'all' || s.role === l.audience_role).sort((a, b) => a.name.localeCompare(b.name));
}

async function isForMe(req, l) {
  if (l.audience === 'all') return true;
  if (l.audience === 'role') return l.audience_role === req.member.role;
  return Boolean(await db.prepare('SELECT 1 AS x FROM team_checklist_people WHERE checklist_id = ? AND member_id = ?').get(l.id, req.member.id));
}

async function items(id) {
  return db.prepare('SELECT * FROM team_checklist_items WHERE checklist_id = ? ORDER BY position, id').all(id);
}

async function progress(listIds, memberId) {
  const out = {};
  for (const id of listIds) {
    const total = (await db.prepare('SELECT COUNT(*) AS c FROM team_checklist_items WHERE checklist_id = ?').get(id)).c;
    const done = (await db.prepare('SELECT COUNT(*) AS c FROM team_checklist_checks WHERE checklist_id = ? AND member_id = ?').get(id, memberId)).c;
    out[id] = { total, done };
  }
  return out;
}

function audienceLabel(l, people) {
  if (l.audience === 'all') return 'All staff';
  if (l.audience === 'role') return (l.roleName || l.audience_role) + ' only';
  return people.map((p) => p.name).join(', ') || 'No one yet';
}

// ------------------------------------------------------------- my lists
router.get('/checklists', async (req, res) => {
  const lists = await db.prepare(`${SELECT} WHERE l.active = 1 AND ${FOR_ME} ORDER BY COALESCE(l.topic, ''), l.title`).all(req.member.role, req.member.id);
  const prog = await progress(lists.map((l) => l.id), req.member.id);
  const topics = [...new Set(lists.map((l) => l.topic || 'General'))];
  const topic = topics.includes(req.query.topic) ? req.query.topic : null;
  res.render('checklists', { title: 'Checklists', lists: topic ? lists.filter((l) => (l.topic || 'General') === topic) : lists, prog, topics, topic, today: fmt.today() });
});

// ------------------------------------------------------------- manage
router.get('/checklists/manage', requirePermission('team_checklists.manage'), async (req, res) => {
  const lists = await db.prepare(`${SELECT} ORDER BY l.active DESC, COALESCE(l.topic, ''), l.title`).all();
  for (const l of lists) {
    const people = await audienceOf(l);
    const total = (await db.prepare('SELECT COUNT(*) AS c FROM team_checklist_items WHERE checklist_id = ?').get(l.id)).c;
    let finished = 0;
    for (const p of people) {
      const done = (await db.prepare('SELECT COUNT(*) AS c FROM team_checklist_checks WHERE checklist_id = ? AND member_id = ?').get(l.id, p.id)).c;
      if (total && done >= total) finished++;
    }
    Object.assign(l, { peopleCount: people.length, total, finished, audienceText: audienceLabel(l, people) });
  }
  res.render('checklists-manage', { title: 'Manage Checklists', lists });
});

async function formData() {
  return {
    roles: await db.prepare("SELECT key, name FROM roles WHERE key <> 'customer' ORDER BY position").all(),
    staff: await staff(),
    topics: (await db.prepare("SELECT DISTINCT topic FROM team_checklists WHERE topic IS NOT NULL AND topic <> '' ORDER BY topic").all()).map((r) => r.topic),
  };
}

router.get('/checklists/new', requirePermission('team_checklists.manage'), async (req, res) => {
  res.render('checklist-form', { title: 'New Checklist', l: { audience: 'all' }, itemText: '', picked: [], ...(await formData()) });
});

async function readForm(req) {
  const title = fmt.clean(req.body.title, 200);
  if (!title) throw new Error('Give the checklist a title.');
  const labels = String(req.body.items || '').split(/\r?\n/).map((s) => fmt.clean(s, 300)).filter(Boolean);
  if (!labels.length) throw new Error('Add at least one item (one per line).');
  if (labels.length > 200) throw new Error('A checklist can have up to 200 items.');
  const audience = ['all', 'role', 'people'].includes(req.body.audience) ? req.body.audience : 'all';
  let role = null;
  if (audience === 'role') {
    const r = await db.prepare("SELECT key FROM roles WHERE key = ? AND key <> 'customer'").get(req.body.audience_role);
    if (!r) throw new Error('Choose which role the checklist is for.');
    role = r.key;
  }
  let people = [];
  if (audience === 'people') {
    const allowed = new Set((await staff()).map((s) => s.id));
    people = [...new Set(asArray(req.body.people).map(Number))].filter((id) => allowed.has(id));
    if (!people.length) throw new Error('Choose at least one person.');
  }
  const due = req.body.due_date ? fmt.dateOnly(req.body.due_date) : null;
  if (req.body.due_date && !due) throw new Error('Check the due date.');
  return { fields: { title, topic: fmt.clean(req.body.topic, 100) || null, description: fmt.clean(req.body.description, 4000) || null, audience, audience_role: role, due_date: due }, labels, people };
}

// Keeps existing items (and everyone's ticks on them) when their text is
// unchanged; new lines become new items; removed lines are removed.
async function saveItems(tx, checklistId, labels) {
  const existing = await tx.prepare('SELECT id, label FROM team_checklist_items WHERE checklist_id = ?').all(checklistId);
  const pool = new Map();
  for (const e of existing) {
    if (!pool.has(e.label)) pool.set(e.label, []);
    pool.get(e.label).push(e.id);
  }
  const keep = new Set();
  for (let i = 0; i < labels.length; i++) {
    const ids = pool.get(labels[i]);
    if (ids && ids.length) {
      const id = ids.shift();
      keep.add(id);
      await tx.prepare('UPDATE team_checklist_items SET position = ? WHERE id = ?').run(i, id);
    } else {
      await tx.prepare('INSERT INTO team_checklist_items (checklist_id, position, label) VALUES (?, ?, ?)').run(checklistId, i, labels[i]);
    }
  }
  for (const e of existing) {
    if (!keep.has(e.id)) {
      await tx.prepare('DELETE FROM team_checklist_checks WHERE item_id = ?').run(e.id);
      await tx.prepare('DELETE FROM team_checklist_items WHERE id = ?').run(e.id);
    }
  }
}

async function savePeople(tx, checklistId, people) {
  await tx.prepare('DELETE FROM team_checklist_people WHERE checklist_id = ?').run(checklistId);
  for (const p of people) await tx.prepare('INSERT INTO team_checklist_people (checklist_id, member_id) VALUES (?, ?)').run(checklistId, p);
}

router.post('/checklists', requirePermission('team_checklists.manage'), action(async (req, res) => {
  const { fields, labels, people } = await readForm(req);
  const id = await db.withTransaction(async (tx) => {
    const info = await tx.prepare('INSERT INTO team_checklists (title, topic, description, audience, audience_role, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(fields.title, fields.topic, fields.description, fields.audience, fields.audience_role, fields.due_date, req.member.id);
    await saveItems(tx, info.lastInsertRowid, labels);
    await savePeople(tx, info.lastInsertRowid, people);
    return info.lastInsertRowid;
  });
  const l = await db.prepare('SELECT * FROM team_checklists WHERE id = ?').get(id);
  for (const p of await audienceOf(l)) {
    if (p.id !== req.member.id) await notifications.notify(p.id, 'checklist', { title: `New checklist: ${l.title}`, body: l.due_date ? `Due ${fmt.d(l.due_date)}` : null, linkUrl: `/checklists/${id}` });
  }
  await audit.log(req, 'team_checklist.create', 'team_checklist', id);
  flash(res, `/checklists/${id}`, 'notice', 'Checklist created and sent to everyone it is for.');
}, '/checklists/new'));

router.get('/checklists/:id/edit', requirePermission('team_checklists.manage'), async (req, res) => {
  const l = await db.prepare('SELECT * FROM team_checklists WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).render('404', { title: 'Not Found' });
  const picked = (await db.prepare('SELECT member_id FROM team_checklist_people WHERE checklist_id = ?').all(l.id)).map((r) => r.member_id);
  res.render('checklist-form', { title: `Edit: ${l.title}`, l, itemText: (await items(l.id)).map((i) => i.label).join('\n'), picked, ...(await formData()) });
});

router.post('/checklists/:id', requirePermission('team_checklists.manage'), action(async (req, res) => {
  const l = await db.prepare('SELECT * FROM team_checklists WHERE id = ?').get(req.params.id);
  if (!l) throw new Error('Checklist not found.');
  const { fields, labels, people } = await readForm(req);
  await db.withTransaction(async (tx) => {
    await tx.prepare('UPDATE team_checklists SET title = ?, topic = ?, description = ?, audience = ?, audience_role = ?, due_date = ?, updated_at = ? WHERE id = ?')
      .run(fields.title, fields.topic, fields.description, fields.audience, fields.audience_role, fields.due_date, fmt.nowText(), l.id);
    await saveItems(tx, l.id, labels);
    await savePeople(tx, l.id, people);
  });
  await audit.log(req, 'team_checklist.update', 'team_checklist', l.id);
  flash(res, `/checklists/${l.id}`, 'notice', 'Saved. Ticks on unchanged items were kept.');
}, (req) => `/checklists/${req.params.id}/edit`));

router.post('/checklists/:id/archive', requirePermission('team_checklists.manage'), action(async (req, res) => {
  const l = await db.prepare('SELECT * FROM team_checklists WHERE id = ?').get(req.params.id);
  if (!l) throw new Error('Checklist not found.');
  const active = l.active ? 0 : 1;
  await db.prepare('UPDATE team_checklists SET active = ?, updated_at = ? WHERE id = ?').run(active, fmt.nowText(), l.id);
  await audit.log(req, active ? 'team_checklist.restore' : 'team_checklist.archive', 'team_checklist', l.id);
  flash(res, '/checklists/manage', 'notice', active ? 'Checklist restored.' : 'Checklist archived. Its history is kept; restore it any time.');
}, '/checklists/manage'));

// ------------------------------------------------------------- one list
router.get('/checklists/:id', async (req, res) => {
  const l = await db.prepare(`${SELECT} WHERE l.id = ?`).get(req.params.id);
  const manage = req.can('team_checklists.manage');
  if (!l || (!manage && (!l.active || !(await isForMe(req, l))))) return res.status(404).render('404', { title: 'Not Found' });
  const its = await items(l.id);
  const forMe = l.active && (await isForMe(req, l));
  const mine = new Map((await db.prepare('SELECT item_id, checked_at FROM team_checklist_checks WHERE checklist_id = ? AND member_id = ?').all(l.id, req.member.id)).map((c) => [c.item_id, c.checked_at]));
  let board = null;
  const people = await audienceOf(l);
  if (manage) {
    const checks = await db.prepare('SELECT item_id, member_id, checked_at FROM team_checklist_checks WHERE checklist_id = ?').all(l.id);
    board = people.map((p) => {
      const got = checks.filter((c) => c.member_id === p.id);
      const last = got.map((c) => c.checked_at).sort().pop() || null;
      return { ...p, done: new Set(got.map((c) => c.item_id)), count: got.length, last };
    });
  }
  res.render('checklist', { title: l.title, l, its, forMe, mine, board, audienceText: audienceLabel(l, people), today: fmt.today() });
});

// Saves my ticks for this checklist.
router.post('/checklists/:id/check', action(async (req, res) => {
  const l = await db.prepare('SELECT * FROM team_checklists WHERE id = ? AND active = 1').get(req.params.id);
  if (!l || !(await isForMe(req, l))) throw new Error('This checklist is not assigned to you.');
  const valid = new Set((await items(l.id)).map((i) => i.id));
  const want = new Set(asArray(req.body.item).map(Number).filter((id) => valid.has(id)));
  await db.withTransaction(async (tx) => {
    const have = new Set((await tx.prepare('SELECT item_id FROM team_checklist_checks WHERE checklist_id = ? AND member_id = ?').all(l.id, req.member.id)).map((r) => r.item_id));
    for (const id of have) if (!want.has(id)) await tx.prepare('DELETE FROM team_checklist_checks WHERE item_id = ? AND member_id = ?').run(id, req.member.id);
    for (const id of want) if (!have.has(id)) await tx.prepare('INSERT INTO team_checklist_checks (checklist_id, item_id, member_id, checked_at) VALUES (?, ?, ?, ?)').run(l.id, id, req.member.id, fmt.nowText());
  });
  const msg = want.size === valid.size ? 'All done. Nice work!' : `Saved (${want.size} of ${valid.size} done).`;
  flash(res, `/checklists/${l.id}`, 'notice', msg);
}, (req) => `/checklists/${req.params.id}`));

module.exports = router;
