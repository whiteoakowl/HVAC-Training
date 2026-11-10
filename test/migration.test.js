// Upgrading a database created by the original (pre-upgrade) app must
// keep every row and every login working, and must be repeatable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('legacy SQLite database upgrades in place without data loss', { skip: Boolean(process.env.TEST_DATABASE_URL) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvac-legacy-'));
  const file = path.join(dir, 'hvac_training.sqlite');
  const Database = require('better-sqlite3');
  const legacy = new Database(file);
  legacy.function('now_text', () => new Date().toISOString().slice(0, 19).replace('T', ' '));
  legacy.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('password123', 4);
  legacy.prepare("INSERT INTO members (name, email, password_hash, role) VALUES ('Old Admin', 'old.admin@example.com', ?, 'admin')").run(hash);
  legacy.prepare("INSERT INTO members (name, email, password_hash, role, phone) VALUES ('Old Student', 'old.student@example.com', ?, 'student', '555-1000')").run(hash);
  legacy.prepare("INSERT INTO events (title, starts_at, created_by) VALUES ('Legacy Event', '2026-01-01 09:00:00', 1)").run();
  legacy.prepare('INSERT INTO event_registrations (event_id, member_id) VALUES (1, 2)').run();
  legacy.prepare("INSERT INTO notifications (member_id, type_key, title) VALUES (2, 'event_registration', 'Hi')").run();
  legacy.close();

  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const db = require('../db');
  const members = await db.prepare('SELECT id, email, role, phone FROM members ORDER BY id').all();
  assert.deepStrictEqual(members.map((m) => [m.id, m.email, m.role]), [[1, 'old.admin@example.com', 'admin'], [2, 'old.student@example.com', 'student']]);
  assert.strictEqual(members[1].phone, '555-1000');
  assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM event_registrations WHERE member_id = 2').get()).c, 1);
  assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM notifications').get()).c, 1);
  const applied = (await db.prepare('SELECT id FROM schema_migrations ORDER BY id').all()).map((r) => r.id);
  assert.ok(applied.includes('001_foundation_rbac') && applied.includes('002_business_core'));
  // FK from children to the rebuilt members table still enforced.
  assert.throws(() => db.prepare('INSERT INTO event_registrations (event_id, member_id) VALUES (1, 999)').run());
  // New roles are now accepted; unknown roles are rejected.
  db.prepare("UPDATE members SET role = 'technician' WHERE id = 2").run();
  assert.throws(() => db.prepare("UPDATE members SET role = 'not_a_role' WHERE id = 2").run());
  // Old admin is the owner with full access.
  const permissions = require('../utils/permissions');
  assert.ok(await permissions.roleCan('admin', 'accounting.manage'));
  // Running migrations again is a no-op.
  const { migrateSqlite } = require('../db/migrate');
  assert.deepStrictEqual(migrateSqlite(db), []);
  db.close();
});
