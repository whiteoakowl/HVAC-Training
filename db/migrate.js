// Versioned, forward-only database migrations.
//
// db/schema.sql is the original (pre-upgrade) baseline and still runs on
// every start with CREATE TABLE IF NOT EXISTS. Every structural change
// made after that lives in db/migrations/NNN_*.js and is applied exactly
// once, in order, and recorded in schema_migrations - so an existing
// production database is upgraded in place and never rebuilt or wiped.
//
// A migration module exports:
//   id        - unique, sortable string ("001_rbac")
//   sql       - SQL (or a function returning SQL) written for SQLite; for
//               Postgres the same SQLite-isms schema.sql uses are
//               rewritten (AUTOINCREMENT, datetime('now'), BLOB)
//   sqlite    - optional SQLite-only SQL, run after `sql`
//   postgres  - optional Postgres-only SQL, run after `sql`
const fs = require('fs');
const path = require('path');

function loadMigrations() {
  const dir = path.join(__dirname, 'migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.js$/.test(f))
    .sort()
    .map((f) => require(path.join(dir, f)));
}

function toPostgres(sql) {
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/\(datetime\('now'\)\)/g, '(now_text())')
    .replace(/\bBLOB\b/g, 'BYTEA');
}

function text(value) {
  return typeof value === 'function' ? value() : value || '';
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`;

// SQLite: synchronous better-sqlite3 handle. Foreign keys are switched
// off while migrating (the documented way to rebuild a table in SQLite)
// and re-checked before they're switched back on.
function migrateSqlite(raw) {
  raw.exec(CREATE_TABLE);
  const applied = new Set(raw.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const pending = loadMigrations().filter((m) => !applied.has(m.id));
  if (!pending.length) return [];
  raw.pragma('foreign_keys = OFF');
  try {
    for (const m of pending) {
      raw.exec('BEGIN');
      try {
        raw.exec(text(m.sql));
        if (m.sqlite) raw.exec(text(m.sqlite));
        const problems = raw.pragma('foreign_key_check');
        if (problems.length) throw new Error(`Migration ${m.id} left ${problems.length} foreign key violation(s)`);
        raw.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(m.id);
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw new Error(`Migration ${m.id} failed: ${err.message}`);
      }
    }
  } finally {
    raw.pragma('foreign_keys = ON');
  }
  return pending.map((m) => m.id);
}

// Postgres: each migration runs in its own transaction under an advisory
// lock, so several serverless instances cold-starting at once can't
// apply the same migration twice.
async function migratePostgres(pool) {
  await pool.query(CREATE_TABLE);
  const done = [];
  for (const m of loadMigrations()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(724001)');
      const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [m.id]);
      if (rows.length) {
        await client.query('COMMIT');
        continue;
      }
      await client.query(toPostgres(text(m.sql)));
      if (m.postgres) await client.query(text(m.postgres));
      await client.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, now_text())', [m.id]);
      await client.query('COMMIT');
      done.push(m.id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${m.id} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return done;
}

module.exports = { migrateSqlite, migratePostgres, loadMigrations };
