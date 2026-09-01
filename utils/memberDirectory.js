// Member Directory - read-only, opt-in "browse other members" list.
// Only the fields an admin has turned on are ever rendered, and a member
// can opt themselves out entirely.
const db = require('../db');

const DIRECTORY_FIELDS = [
  { key: 'photo', label: 'Photo' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'email', label: 'Email' },
];

async function getFieldSettings() {
  const rows = await db.prepare('SELECT field_key, visible FROM member_directory_field_settings').all();
  const visibleByKey = new Map(rows.map((r) => [r.field_key, r.visible === 1]));
  return DIRECTORY_FIELDS.map((f) => ({ ...f, visible: visibleByKey.get(f.key) || false }));
}

async function setFieldVisibility(visibleKeys) {
  for (const field of DIRECTORY_FIELDS) {
    const visible = visibleKeys.includes(field.key) ? 1 : 0;
    await db
      .prepare('INSERT INTO member_directory_field_settings (field_key, visible) VALUES (?, ?) ON CONFLICT (field_key) DO UPDATE SET visible = excluded.visible')
      .run(field.key, visible);
  }
}

async function isOptedOut(memberId) {
  return !!(await db.prepare('SELECT 1 FROM member_directory_opt_outs WHERE member_id = ?').get(memberId));
}

async function setOptedOut(memberId, optedOut) {
  if (optedOut) {
    await db.prepare('INSERT INTO member_directory_opt_outs (member_id) VALUES (?) ON CONFLICT (member_id) DO NOTHING').run(memberId);
  } else {
    await db.prepare('DELETE FROM member_directory_opt_outs WHERE member_id = ?').run(memberId);
  }
}

async function listDirectoryMembers() {
  return db.prepare("SELECT * FROM members WHERE active = 1 AND id NOT IN (SELECT member_id FROM member_directory_opt_outs) ORDER BY name").all();
}

async function getDirectoryMember(id) {
  return db.prepare("SELECT * FROM members WHERE id = ? AND active = 1 AND id NOT IN (SELECT member_id FROM member_directory_opt_outs)").get(id);
}

module.exports = { DIRECTORY_FIELDS, getFieldSettings, setFieldVisibility, isOptedOut, setOptedOut, listDirectoryMembers, getDirectoryMember };
