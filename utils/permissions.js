// Role-based access control. Each member has one role (members.role ->
// roles.key); each role holds a configurable set of permission keys
// (role_permissions). 'system.admin' implies every permission.
//
// Lookups are cached per process for a few seconds - serverless
// instances each keep their own cache, so an edit made on one instance
// reaches the others within CACHE_MS.
const db = require('../db');

const CACHE_MS = 5000;
let cache = { at: 0, byRole: new Map() };

async function loadAll() {
  if (Date.now() - cache.at < CACHE_MS) return cache.byRole;
  const rows = await db.prepare('SELECT role_key, permission_key FROM role_permissions').all();
  const byRole = new Map();
  for (const r of rows) {
    if (!byRole.has(r.role_key)) byRole.set(r.role_key, new Set());
    byRole.get(r.role_key).add(r.permission_key);
  }
  cache = { at: Date.now(), byRole };
  return byRole;
}

function invalidate() {
  cache = { at: 0, byRole: new Map() };
}

async function permissionsForRole(role) {
  return (await loadAll()).get(role) || new Set();
}

function makeChecker(perms) {
  const isOwner = perms.has('system.admin');
  return (...keys) => isOwner || keys.some((k) => perms.has(k));
}

async function roleCan(role, ...keys) {
  return makeChecker(await permissionsForRole(role))(...keys);
}

// Active members whose role grants any of the given permissions - used
// to route notifications ("notify everyone who can manage inventory").
async function membersWith(...keys) {
  const members = await db.prepare('SELECT id, name, role FROM members WHERE active = 1').all();
  const out = [];
  for (const m of members) if (await roleCan(m.role, ...keys)) out.push(m);
  return out;
}

async function listRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY position, name').all();
}

async function listPermissions() {
  return db.prepare('SELECT * FROM permissions ORDER BY module, key').all();
}

async function getRole(key) {
  return db.prepare('SELECT * FROM roles WHERE key = ?').get(key);
}

async function setRolePermissions(roleKey, keys) {
  const valid = new Set((await listPermissions()).map((p) => p.key));
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM role_permissions WHERE role_key = ?').run(roleKey);
    for (const k of new Set(keys)) {
      if (valid.has(k)) await tx.prepare('INSERT INTO role_permissions (role_key, permission_key) VALUES (?, ?)').run(roleKey, k);
    }
  });
  invalidate();
}

// Where "Home" goes for a role.
function homeFor(can) {
  if (can('system.admin')) return '/manage';
  if (can('portal.customer')) return '/my';
  if (can('portal.management')) return '/manage';
  if (can('portal.service')) return '/service';
  if (can('portal.employee')) return '/employee';
  return '/portal';
}

module.exports = { permissionsForRole, makeChecker, roleCan, membersWith, listRoles, listPermissions, getRole, setRolePermissions, invalidate, homeFor };
