// Workflow automation. Each rule can be switched on/off in Company
// Settings (settings.automation_*), and every run - including skipped
// ones - is written to automation_runs so there's a history of what the
// system did on its own. Rules never move money: the "invoice on
// completion" rule only creates a DRAFT invoice for a person to review
// and issue, and customer-facing messages require their own setting.
const db = require('../db');
const settings = require('./settings');
const notifications = require('./notifications');
const permissions = require('./permissions');

const RULES = {
  automation_notify_new_request: 'Notify customer service when a service request arrives',
  automation_customer_request_confirmation: 'Email/text the customer a confirmation when their request arrives (needs a messaging provider)',
  automation_notify_job_assigned: 'Notify technicians when they are assigned to a job',
  automation_draft_invoice_on_completion: 'Create a draft invoice (for review) when a job is completed',
  automation_low_stock_alerts: 'Alert inventory managers when stock falls to its minimum',
};

async function record(ruleKey, entityType, entityId, result) {
  await db.prepare('INSERT INTO automation_runs (rule_key, entity_type, entity_id, result) VALUES (?, ?, ?, ?)').run(ruleKey, entityType, entityId, String(result).slice(0, 500));
}

// Runs fn() if the rule is enabled; logs the outcome either way. Errors
// are logged, not thrown - an automation failing must never roll back
// the user action that triggered it.
async function run(ruleKey, entityType, entityId, fn) {
  if (!(await settings.getBool(ruleKey))) {
    await record(ruleKey, entityType, entityId, 'skipped (rule disabled)');
    return null;
  }
  try {
    const result = await fn();
    await record(ruleKey, entityType, entityId, result || 'done');
    return result;
  } catch (err) {
    console.error(`automation ${ruleKey} failed:`, err);
    await record(ruleKey, entityType, entityId, 'error: ' + err.message);
    return null;
  }
}

async function notifyPermission(perms, typeKey, payload, exceptMemberId = null) {
  const people = await permissions.membersWith(...perms);
  let n = 0;
  for (const p of people) {
    if (p.id === exceptMemberId) continue;
    await notifications.notify(p.id, typeKey, payload);
    n++;
  }
  return n;
}

async function history(limit = 200) {
  return db.prepare(`SELECT * FROM automation_runs ORDER BY id DESC LIMIT ${Math.min(parseInt(limit, 10) || 200, 1000)}`).all();
}

module.exports = { RULES, run, record, notifyPermission, history };
