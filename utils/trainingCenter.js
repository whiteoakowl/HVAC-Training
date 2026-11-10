// Training center additions on top of the original training engine:
// categories, renewal periods (e.g. safety refreshers every 12 months),
// required courses per role, and a company-wide completion matrix.
const db = require('../db');
const fmt = require('./format');
const agreementsUtil = require('./agreements');

const CATEGORIES = [
  'HVAC Fundamentals', 'Heating Systems', 'Air Conditioning', 'Heat Pumps', 'Electrical Fundamentals', 'Refrigeration', 'Airflow & Ductwork', 'Troubleshooting',
  'Installation', 'Preventative Maintenance', 'Customer Service', 'Sales', 'Safety', 'EPA Certification Prep', 'Company Policies', 'Manufacturer Training',
];

function expiresOn(completedAt, renewMonths) {
  if (!completedAt || !renewMonths) return null;
  return agreementsUtil.addMonths(String(completedAt).slice(0, 10), renewMonths);
}

async function requirements() {
  return db.prepare('SELECT rt.*, t.title, r.name AS "roleName" FROM required_trainings rt JOIN trainings t ON t.id = rt.training_id JOIN roles r ON r.key = rt.role_key ORDER BY r.position, t.title').all();
}

async function setRequirement(roleKey, trainingId, dueDays, on) {
  if (on) {
    await db
      .prepare('INSERT INTO required_trainings (role_key, training_id, due_days) VALUES (?, ?, ?) ON CONFLICT (role_key, training_id) DO UPDATE SET due_days = excluded.due_days')
      .run(roleKey, trainingId, Math.max(1, parseInt(dueDays, 10) || 30));
  } else {
    await db.prepare('DELETE FROM required_trainings WHERE role_key = ? AND training_id = ?').run(roleKey, trainingId);
  }
}

// Assigns required courses that are missing, and re-opens passed courses
// whose renewal period has run out. Returns counts.
async function sync() {
  const today = fmt.today();
  let assigned = 0;
  let renewed = 0;
  const reqs = await db
    .prepare("SELECT rt.*, t.status AS \"tStatus\" FROM required_trainings rt JOIN trainings t ON t.id = rt.training_id WHERE t.status = 'published'")
    .all();
  for (const r of reqs) {
    const members = await db.prepare('SELECT id FROM members WHERE active = 1 AND role = ?').all(r.role_key);
    for (const m of members) {
      const info = await db
        .prepare('INSERT INTO training_assignments (training_id, member_id, due_at) VALUES (?, ?, ?) ON CONFLICT (training_id, member_id) DO NOTHING')
        .run(r.training_id, m.id, fmt.addDays(today, r.due_days) + ' 23:59:59');
      if (info.changes > 0) assigned++;
    }
  }
  const passed = await db
    .prepare("SELECT ta.id, ta.completed_at, t.renew_months FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id WHERE ta.status = 'passed' AND t.renew_months IS NOT NULL AND t.renew_months > 0")
    .all();
  for (const p of passed) {
    const exp = expiresOn(p.completed_at, p.renew_months);
    if (exp && exp <= today) {
      await db.prepare("UPDATE training_assignments SET status = 'retry_required', due_at = ? WHERE id = ?").run(fmt.addDays(today, 30) + ' 23:59:59', p.id);
      renewed++;
    }
  }
  return { assigned, renewed };
}

async function matrix() {
  const trainings = await db.prepare("SELECT id, title, category, renew_months FROM trainings WHERE status = 'published' ORDER BY category, title").all();
  const people = await db.prepare("SELECT m.id, m.name, m.role, r.name AS \"roleName\" FROM members m LEFT JOIN roles r ON r.key = m.role WHERE m.active = 1 AND m.role NOT IN ('customer') ORDER BY m.name").all();
  const assignments = await db.prepare('SELECT training_id, member_id, status, completed_at, due_at, best_score FROM training_assignments').all();
  const reqs = await db.prepare('SELECT role_key, training_id FROM required_trainings').all();
  const today = fmt.today();
  const cell = (t, p) => {
    const a = assignments.find((x) => x.training_id === t.id && x.member_id === p.id);
    const required = reqs.some((r) => r.role_key === p.role && r.training_id === t.id);
    if (!a) return { state: required ? 'missing' : 'none', required };
    const exp = a.status === 'passed' ? expiresOn(a.completed_at, t.renew_months) : null;
    const overdue = a.status !== 'passed' && a.due_at && a.due_at.slice(0, 10) < today;
    return { state: a.status === 'passed' ? 'passed' : overdue ? 'overdue' : a.status, required, completed: a.completed_at && a.completed_at.slice(0, 10), expires: exp, score: a.best_score };
  };
  return { trainings, people, rows: people.map((p) => ({ p, cells: trainings.map((t) => cell(t, p)) })) };
}

module.exports = { CATEGORIES, expiresOn, requirements, setRequirement, sync, matrix };
