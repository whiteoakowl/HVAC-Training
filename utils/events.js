// Event Calendar - trimmed from the reference app's version (no
// volunteer roles/donation items/submission-for-approval flow): a
// member registers or cancels, an instructor/admin creates/edits/
// deletes. Visibility is 'public' (shown to a signed-out visitor too,
// though this app has no public route wired up for it) or 'members'.
const db = require('../db');

async function listUpcoming() {
  return db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'registered') AS "registeredCount"
       FROM events e WHERE e.starts_at >= datetime('now', '-1 day') ORDER BY e.starts_at`
    )
    .all();
}

async function listAll() {
  return db.prepare('SELECT * FROM events ORDER BY starts_at DESC').all();
}

async function getEvent(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

async function createEvent(data, createdBy) {
  const info = await db
    .prepare('INSERT INTO events (title, description, location, category, starts_at, ends_at, capacity, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(data.title, data.description || null, data.location || null, data.category || null, data.startsAt, data.endsAt || null, data.capacity || null, data.visibility || 'members', createdBy);
  return info.lastInsertRowid;
}

async function updateEvent(id, data) {
  await db
    .prepare('UPDATE events SET title = ?, description = ?, location = ?, category = ?, starts_at = ?, ends_at = ?, capacity = ?, visibility = ?, updated_at = now_text() WHERE id = ?')
    .run(data.title, data.description || null, data.location || null, data.category || null, data.startsAt, data.endsAt || null, data.capacity || null, data.visibility || 'members', id);
}

async function deleteEvent(id) {
  await db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

async function registrationsFor(eventId) {
  return db
    .prepare(`SELECT r.*, m.name FROM event_registrations r JOIN members m ON m.id = r.member_id WHERE r.event_id = ? AND r.status = 'registered' ORDER BY r.created_at`)
    .all(eventId);
}

async function isRegistered(eventId, memberId) {
  return !!(await db.prepare(`SELECT 1 FROM event_registrations WHERE event_id = ? AND member_id = ? AND status = 'registered'`).get(eventId, memberId));
}

// Returns { ok, error/notice } - capacity is enforced here, not just in
// the UI, since a second tab or a slow double-click could otherwise
// register the same member (or overfill the event) past the check the
// view already renders.
async function register(eventId, memberId) {
  const event = await getEvent(eventId);
  if (!event) return { ok: false, error: 'Event not found.' };
  if (await isRegistered(eventId, memberId)) return { ok: false, error: 'You are already registered.' };
  if (event.capacity != null) {
    const row = await db.prepare(`SELECT COUNT(*) AS c FROM event_registrations WHERE event_id = ? AND status = 'registered'`).get(eventId);
    if (row.c >= event.capacity) return { ok: false, error: 'This event is full.' };
  }
  await db
    .prepare(
      `INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'registered')
       ON CONFLICT (event_id, member_id) DO UPDATE SET status = 'registered'`
    )
    .run(eventId, memberId);
  return { ok: true, notice: `You're registered for ${event.title}.` };
}

async function unregister(eventId, memberId) {
  await db.prepare(`UPDATE event_registrations SET status = 'cancelled' WHERE event_id = ? AND member_id = ?`).run(eventId, memberId);
}

module.exports = { listUpcoming, listAll, getEvent, createEvent, updateEvent, deleteEvent, registrationsFor, isRegistered, register, unregister };
