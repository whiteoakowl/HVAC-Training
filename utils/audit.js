// Append-only audit trail. Every create/update/delete in the business
// modules, every login, and every permission change is recorded here.
const db = require('../db');

async function log(req, action, entityType = null, entityId = null, details = null, tx = db) {
  const memberId = req && req.member ? req.member.id : null;
  const fwd = req && req.headers && req.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim() : req ? req.ip : null;
  await tx
    .prepare('INSERT INTO audit_log (member_id, action, entity_type, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(memberId, action, entityType, entityId === null || entityId === undefined ? null : String(entityId), details ? JSON.stringify(details) : null, ip || null);
}

async function list({ entityType = null, entityId = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (entityType) {
    where.push('a.entity_type = ?');
    params.push(entityType);
  }
  if (entityId) {
    where.push('a.entity_id = ?');
    params.push(String(entityId));
  }
  const max = Math.min(parseInt(limit, 10) || 200, 1000);
  return db
    .prepare(`SELECT a.*, m.name AS "memberName" FROM audit_log a LEFT JOIN members m ON m.id = a.member_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${max}`)
    .all(...params);
}

module.exports = { log, list };
