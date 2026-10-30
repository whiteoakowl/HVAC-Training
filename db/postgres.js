// Postgres driver (Supabase or any Postgres), used when db/config.js finds
// a connection string. Wraps node-postgres in the same
// prepare(sql).get/.all/.run() shape as better-sqlite3 so none of the
// utils/*.js call sites need to know which database they're talking to:
// `?` placeholders become $1, $2..., INSERTs get `RETURNING *` so .run()
// can report lastInsertRowid, and COUNT(*)'s bigint comes back as a
// plain number instead of a string.
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const { postgresUrl } = require('./config');

types.setTypeParser(20, (v) => parseInt(v, 10)); // int8 (COUNT(*), SUM)

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(postgresUrl) || /host=\/|@\//.test(postgresUrl);
const pool = new Pool({
  connectionString: postgresUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Serverless instances each hold their own pool - keep it small and
  // use Supabase's pooler (port 6543) connection string in production.
  max: process.env.PG_POOL_MAX ? parseInt(process.env.PG_POOL_MAX, 10) : 3,
});

function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function statement(runQuery, sql) {
  const text = toPg(sql);
  const isInsert = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql);
  return {
    async get(...params) {
      await ready;
      return (await runQuery(text, params)).rows[0];
    },
    async all(...params) {
      await ready;
      return (await runQuery(text, params)).rows;
    },
    async run(...params) {
      await ready;
      const result = await runQuery(isInsert ? `${text} RETURNING *` : text, params);
      const row = result.rows && result.rows[0];
      return { changes: result.rowCount, lastInsertRowid: row && row.id !== undefined ? row.id : undefined };
    },
  };
}

const db = {
  driver: 'postgres',
  close: () => pool.end(),
  prepare: (sql) => statement((text, params) => pool.query(text, params), sql),
  // Runs fn on one dedicated connection inside BEGIN/COMMIT; fn must use
  // the `tx` it's given (not `db`) for statements that belong to it.
  async withTransaction(fn) {
    await ready;
    const client = await pool.connect();
    const tx = { prepare: (sql) => statement((text, params) => client.query(text, params), sql) };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};

async function initSchema() {
  const schema = fs
    .readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/\(datetime\('now'\)\)/g, '(now_text())')
    .replace(/\bBLOB\b/g, 'BYTEA');
  await pool.query(`
    CREATE OR REPLACE FUNCTION now_text() RETURNS TEXT LANGUAGE SQL STABLE AS
    $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $$;
  `);
  await pool.query(schema);
}

const ready = initSchema();
ready.catch((err) => console.error('Postgres schema init failed:', err.message));
db.ready = ready;

module.exports = db;
