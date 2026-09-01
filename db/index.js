// Thin database bootstrap around better-sqlite3. better-sqlite3's own
// Statement API (prepare().get/.all/.run()) is already synchronous and
// already returns { changes, lastInsertRowid } from .run() - the exact
// shape the rest of this app's utils/*.js files expect (mirroring the
// reference app's own db.prepare().get/.all/.run() pattern) - so this
// file only adds two things on top of the raw driver: a `now_text()` SQL
// function (used in schema.sql defaults and in UPDATE ... = now_text()
// statements) and a withTransaction() helper for multi-statement writes
// that must all succeed or all roll back together (e.g. grading a quiz).
//
// Every query in this app still reads `await db.prepare(sql).get(...)`
// even though better-sqlite3 never returns a Promise - awaiting a plain
// value just resolves to that value immediately, so the call sites stay
// forward-compatible with a real async driver (e.g. swapping in
// PostgreSQL later) without ever needing to change.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hvac_training.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.function('now_text', () => new Date().toISOString().slice(0, 19).replace('T', ' '));

function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}
initSchema();

// better-sqlite3's own db.transaction() wrapper only supports a
// SYNCHRONOUS callback - it commits immediately after the callback
// function returns, and an async callback returns a pending Promise on
// its very first `await` rather than running to completion, which would
// commit before the rest of the callback's statements ever ran. Every
// utils/*.js call site here passes an `async (tx) => {...}` callback (to
// stay parity with the reference app's own Promise-based db API), so
// this manages BEGIN/COMMIT/ROLLBACK directly and awaits the whole
// callback before committing.
db.withTransaction = async function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = await fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

module.exports = db;
