// Company settings (key/value). Defaults are seeded by migration 001.
const db = require('../db');

async function all() {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function get(key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value !== null ? row.value : fallback;
}

async function getInt(key, fallback = 0) {
  const n = parseInt(await get(key, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function getBool(key) {
  return (await get(key, '0')) === '1';
}

async function set(key, value) {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));
}

// Keeps utils/format and the database's now_text() on the company
// timezone. Re-read at most once a minute per server instance.
let tzCheckedAt = 0;
async function applyTimezone(force = false) {
  if (!force && Date.now() - tzCheckedAt < 60000) return;
  tzCheckedAt = Date.now();
  const fmt = require('./format');
  const tz = process.env.APP_TIMEZONE || (await get('company_timezone', 'America/New_York'));
  if (!fmt.validTimezone(tz)) return;
  if (tz !== fmt.timezone() || force) {
    fmt.setTimezone(tz);
    await db.setTimezone(tz);
  }
}

module.exports = { all, get, getInt, getBool, set, applyTimezone };
