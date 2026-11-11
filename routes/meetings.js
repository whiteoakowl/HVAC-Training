// Meetings tab (employee + management portals): calendar and list views
// of scheduled meetings; open one and join its video call. Managers
// (meetings.manage) schedule, edit and cancel meetings.
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../db');
const M = require('../utils/meetings');
const notifications = require('../utils/notifications');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action, asArray, int } = require('../utils/http');

router.use('/meetings', requireAuth, requirePermission('meetings.view', 'meetings.manage'));

// Meetings I'm invited to (managers: also every meeting on /meetings/manage).
function mine(req) {
  return { can: (...k) => k.includes('meetings.manage') ? false : req.can(...k), member: req.member };
}

async function decorate(rows) {
  const now = fmt.nowText();
  for (const m of rows) {
    m.phase = M.phase(m, now);
    m.endsAt = M.endsAt(m);
    m.joinUrl = m.video_kind === 'none' ? null : `/meetings/${m.id}/join`;
  }
  return rows;
}

function monthParam(v) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? v : fmt.today().slice(0, 7);
}

async function renderList(req, res, { manage }) {
  const view = req.query.view === 'calendar' ? 'calendar' : 'list';
  const scope = manage ? req : mine(req);
  const month = monthParam(req.query.month);
  const today = fmt.today();
  let upcoming = [];
  let past = [];
  let weeks = null;
  if (view === 'calendar') {
    const rows = await decorate(await M.list(scope, { from: `${month}-01`, to: `${M.nextMonth(month)}-01` }));
    weeks = M.monthGrid(month, rows);
  } else {
    const rows = await decorate(await M.list(scope, { from: fmt.addDays(today, manage ? -60 : -30) }));
    upcoming = rows.filter((m) => m.phase !== 'ended' && m.phase !== 'cancelled');
    past = rows.filter((m) => m.phase === 'ended' || m.phase === 'cancelled').reverse();
  }
  res.render('meetings', {
    title: manage ? 'Manage Meetings' : 'Meetings', manage, view, month, weeks, upcoming, past, today,
    monthName: M.monthName(month), prev: M.prevMonth(month), next: M.nextMonth(month),
  });
}

router.get('/meetings', (req, res) => renderList(req, res, { manage: false }));
router.get('/meetings/manage', requirePermission('meetings.manage'), (req, res) => renderList(req, res, { manage: true }));

async function formData() {
  return {
    roles: await db.prepare("SELECT key, name FROM roles WHERE key <> 'customer' ORDER BY position").all(),
    staff: await M.staff(),
    durations: M.DURATIONS,
    domain: await M.videoDomain(),
  };
}

router.get('/meetings/new', requirePermission('meetings.manage'), async (req, res) => {
  const date = fmt.dateOnly(req.query.date);
  res.render('meeting-form', { title: 'Schedule a Meeting', m: { starts_at: date ? `${date} 09:00:00` : '', duration_minutes: 30, audience: 'all', video_kind: 'builtin' }, invited: [], ...(await formData()) });
});

// Validates the form; returns the fields to save plus the attendee ids.
async function readForm(req) {
  const title = fmt.clean(req.body.title, 200);
  if (!title) throw new Error('Give the meeting a title.');
  const startsAt = fmt.fromLocalInput(req.body.starts_at);
  if (!startsAt) throw new Error('Choose the date and time.');
  const duration = int(req.body.duration_minutes);
  if (!duration || duration < 5 || duration > 600) throw new Error('Choose how long the meeting lasts.');
  const audience = ['all', 'role', 'people'].includes(req.body.audience) ? req.body.audience : 'all';
  let role = null;
  if (audience === 'role') {
    const r = await db.prepare("SELECT key FROM roles WHERE key = ? AND key <> 'customer'").get(req.body.audience_role);
    if (!r) throw new Error('Choose which role is invited.');
    role = r.key;
  }
  let people = [];
  if (audience === 'people') {
    const allowed = new Set((await M.staff()).map((s) => s.id));
    people = [...new Set(asArray(req.body.people).map(Number))].filter((id) => allowed.has(id));
    if (!people.length) throw new Error('Choose at least one person to invite.');
  }
  const kind = ['builtin', 'link', 'none'].includes(req.body.video_kind) ? req.body.video_kind : 'builtin';
  let link = null;
  if (kind === 'link') {
    link = M.cleanLink(req.body.video_url);
    if (!link) throw new Error('Paste the full video link, starting with https:// (Zoom, Google Meet, Teams...).');
  }
  return {
    fields: { title, description: fmt.clean(req.body.description, 4000) || null, starts_at: startsAt, duration_minutes: duration, audience, audience_role: role, video_kind: kind, video_url: link, location: fmt.clean(req.body.location, 300) || null },
    people,
  };
}

async function notifyInvitees(m, title, body, exceptId) {
  for (const id of await M.invitees(m)) {
    if (id !== exceptId) await notifications.notify(id, 'meeting', { title, body, linkUrl: `/meetings/${m.id}` });
  }
}

function when(m) {
  return `${fmt.dt(m.starts_at)} (${m.duration_minutes} min)`;
}

router.post('/meetings', requirePermission('meetings.manage'), action(async (req, res) => {
  const { fields, people } = await readForm(req);
  const id = await db.withTransaction(async (tx) => {
    const info = await tx.prepare('INSERT INTO meetings (title, description, starts_at, duration_minutes, audience, audience_role, video_kind, video_url, location, room_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fields.title, fields.description, fields.starts_at, fields.duration_minutes, fields.audience, fields.audience_role, fields.video_kind, fields.video_url, fields.location, M.newRoomKey(), req.member.id);
    for (const p of people) await tx.prepare('INSERT INTO meeting_attendees (meeting_id, member_id) VALUES (?, ?)').run(info.lastInsertRowid, p);
    return info.lastInsertRowid;
  });
  const m = await db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  await notifyInvitees(m, `Meeting: ${m.title}`, when(m), req.member.id);
  await audit.log(req, 'meeting.create', 'meeting', id);
  flash(res, `/meetings/${id}`, 'notice', 'Meeting scheduled. Everyone invited was notified.');
}, '/meetings/new'));

router.get('/meetings/:id', async (req, res) => {
  const m = await M.find(req, req.params.id);
  if (!m) return res.status(404).render('404', { title: 'Not Found' });
  await decorate([m]);
  res.render('meeting', {
    title: m.title, m, audienceLabel: await M.audienceLabel(m), videoUrl: await M.videoUrl(m),
    joinEarly: M.JOIN_EARLY_MINUTES,
  });
});

router.get('/meetings/:id/edit', requirePermission('meetings.manage'), async (req, res) => {
  const m = await M.find(req, req.params.id);
  if (!m) return res.status(404).render('404', { title: 'Not Found' });
  res.render('meeting-form', { title: `Edit: ${m.title}`, m, invited: (await M.attendees(m.id)).map((a) => a.id), ...(await formData()) });
});

router.post('/meetings/:id', requirePermission('meetings.manage'), action(async (req, res) => {
  const before = await M.find(req, req.params.id);
  if (!before) throw new Error('Meeting not found.');
  if (before.status === 'cancelled') throw new Error('This meeting was cancelled. Schedule a new one instead.');
  const { fields, people } = await readForm(req);
  await db.withTransaction(async (tx) => {
    await tx.prepare('UPDATE meetings SET title = ?, description = ?, starts_at = ?, duration_minutes = ?, audience = ?, audience_role = ?, video_kind = ?, video_url = ?, location = ?, updated_at = ? WHERE id = ?')
      .run(fields.title, fields.description, fields.starts_at, fields.duration_minutes, fields.audience, fields.audience_role, fields.video_kind, fields.video_url, fields.location, fmt.nowText(), before.id);
    await tx.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(before.id);
    for (const p of people) await tx.prepare('INSERT INTO meeting_attendees (meeting_id, member_id) VALUES (?, ?)').run(before.id, p);
  });
  const m = await db.prepare('SELECT * FROM meetings WHERE id = ?').get(before.id);
  const moved = m.starts_at !== before.starts_at || m.duration_minutes !== before.duration_minutes;
  if (moved) await notifyInvitees(m, `Meeting moved: ${m.title}`, `Now ${when(m)}`, req.member.id);
  await audit.log(req, 'meeting.update', 'meeting', m.id, { moved });
  flash(res, `/meetings/${m.id}`, 'notice', moved ? 'Saved. Everyone invited was told about the new time.' : 'Saved.');
}, (req) => `/meetings/${req.params.id}/edit`));

router.post('/meetings/:id/cancel', requirePermission('meetings.manage'), action(async (req, res) => {
  const m = await M.find(req, req.params.id);
  if (!m) throw new Error('Meeting not found.');
  if (m.status !== 'cancelled') {
    await db.prepare("UPDATE meetings SET status = 'cancelled', updated_at = ? WHERE id = ?").run(fmt.nowText(), m.id);
    await notifyInvitees(m, `Meeting cancelled: ${m.title}`, `Was ${when(m)}`, req.member.id);
    await audit.log(req, 'meeting.cancel', 'meeting', m.id);
  }
  flash(res, `/meetings/${m.id}`, 'notice', 'Meeting cancelled. Everyone invited was notified.');
}, (req) => `/meetings/${req.params.id}`));

// "Join video call": sends the person to the meeting's video room.
router.get('/meetings/:id/join', async (req, res) => {
  const m = await M.find(req, req.params.id);
  if (!m) return res.status(404).render('404', { title: 'Not Found' });
  const url = await M.videoUrl(m);
  if (m.status === 'cancelled' || !url) return flash(res, `/meetings/${m.id}`, 'error', m.status === 'cancelled' ? 'This meeting was cancelled.' : 'This meeting is in person; there is no video call.');
  res.redirect(url);
});

module.exports = router;
