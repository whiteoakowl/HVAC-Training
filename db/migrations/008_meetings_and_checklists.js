// Meetings (calendar / list, join a video call) and team checklists
// (managers create checklists by topic; each person ticks their own
// boxes). Adds tables and permissions only; no existing data changes.
const STAFF_PORTALS = "('portal.employee','portal.service','portal.management')";
const MANAGERS = ['general_manager', 'office_manager', 'service_manager', 'instructor'];

function grantToStaff(perm) {
  return `INSERT INTO role_permissions (role_key, permission_key) SELECT DISTINCT role_key, '${perm}' FROM role_permissions WHERE permission_key IN ${STAFF_PORTALS} ON CONFLICT DO NOTHING;`;
}
function grantTo(role, perm) {
  return `INSERT INTO role_permissions (role_key, permission_key) SELECT '${role}', '${perm}' WHERE EXISTS (SELECT 1 FROM roles WHERE key = '${role}') ON CONFLICT DO NOTHING;`;
}

module.exports = {
  id: '008_meetings_and_checklists',
  sql: `
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','role','people')),
  audience_role TEXT REFERENCES roles(key) ON DELETE SET NULL,
  video_kind TEXT NOT NULL DEFAULT 'builtin' CHECK (video_kind IN ('builtin','link','none')),
  video_url TEXT,
  room_key TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings (starts_at);
CREATE TABLE IF NOT EXISTS meeting_attendees (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, member_id)
);

CREATE TABLE IF NOT EXISTS team_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  topic TEXT,
  description TEXT,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','role','people')),
  audience_role TEXT REFERENCES roles(key) ON DELETE SET NULL,
  due_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS team_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_id INTEGER NOT NULL REFERENCES team_checklists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_checklist_items ON team_checklist_items (checklist_id, position);
CREATE TABLE IF NOT EXISTS team_checklist_people (
  checklist_id INTEGER NOT NULL REFERENCES team_checklists(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (checklist_id, member_id)
);
CREATE TABLE IF NOT EXISTS team_checklist_checks (
  checklist_id INTEGER NOT NULL REFERENCES team_checklists(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES team_checklist_items(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_team_checklist_checks ON team_checklist_checks (checklist_id, member_id);

INSERT INTO permissions (key, label, module) VALUES ('meetings.view', 'See and join meetings', 'Meetings') ON CONFLICT (key) DO NOTHING;
INSERT INTO permissions (key, label, module) VALUES ('meetings.manage', 'Schedule, edit and cancel meetings', 'Meetings') ON CONFLICT (key) DO NOTHING;
INSERT INTO permissions (key, label, module) VALUES ('team_checklists.use', 'Use team checklists', 'Checklists') ON CONFLICT (key) DO NOTHING;
INSERT INTO permissions (key, label, module) VALUES ('team_checklists.manage', 'Create team checklists and see who completed them', 'Checklists') ON CONFLICT (key) DO NOTHING;
UPDATE permissions SET label = 'Build job inspection checklists (service forms)' WHERE key = 'checklists.manage';
${grantToStaff('meetings.view')}
${grantToStaff('team_checklists.use')}
${MANAGERS.map((r) => grantTo(r, 'meetings.manage') + '\n' + grantTo(r, 'team_checklists.manage') + '\n' + grantTo(r, 'meetings.view') + '\n' + grantTo(r, 'team_checklists.use')).join('\n')}
INSERT INTO settings (key, value) VALUES ('meeting_video_domain', 'meet.jit.si') ON CONFLICT (key) DO NOTHING;
`,
};
