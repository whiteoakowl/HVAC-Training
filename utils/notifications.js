// Communication tab = in-app Notification Center. Simplified from the
// reference app's SMS/email notification framework: every notification
// here is in-app only (no email/SMS provider in this build), generated
// by notify() and called from events/training/forums whenever something
// relevant happens to a member.
const db = require('../db');

const TYPES = {
  event_registration: 'Event Registration',
  training_assigned: 'Training Assigned',
  forum_reply: 'Chat Reply',
  document_added: 'New Document',
};

async function notify(memberId, typeKey, { title, body = null, linkUrl = null } = {}) {
  await db.prepare('INSERT INTO notifications (member_id, type_key, title, body, link_url) VALUES (?, ?, ?, ?, ?)').run(memberId, typeKey, title, body, linkUrl);
}

async function listForMember(memberId) {
  return db.prepare('SELECT * FROM notifications WHERE member_id = ? ORDER BY created_at DESC').all(memberId);
}

async function unreadCount(memberId) {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE member_id = ? AND read_at IS NULL').get(memberId);
  return row ? row.c : 0;
}

async function markRead(memberId, notificationId) {
  await db.prepare('UPDATE notifications SET read_at = now_text() WHERE id = ? AND member_id = ? AND read_at IS NULL').run(notificationId, memberId);
}

async function markAllRead(memberId) {
  await db.prepare('UPDATE notifications SET read_at = now_text() WHERE member_id = ? AND read_at IS NULL').run(memberId);
}

module.exports = { TYPES, notify, listForMember, unreadCount, markRead, markAllRead };
