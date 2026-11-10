// Daily automations. Run once a day by netlify/functions/daily.js
// (Netlify Scheduled Function) or on demand from Admin -> Audit &
// Automation. Every rule is toggled in Company Settings and every run is
// logged in automation_runs. Rules here only notify, create jobs/drafts,
// assign training, or expire stale estimates - none of them moves money.
// Customer-facing reminders need their own setting AND a provider.
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');
const automation = require('./automation');
const notifications = require('./notifications');
const messaging = require('./messaging');
const agreements = require('./agreements');
const estimates = require('./estimates');
const expenses = require('./expenses');
const trainingCenter = require('./trainingCenter');
const invoices = require('./invoices');

// One run per calendar day unless forced.
async function runDaily({ force = false, origin = 'schedule' } = {}) {
  await settings.applyTimezone(true);
  const today = fmt.today();
  if (!force && (await settings.get('last_daily_run', '')) === today) return { skipped: true, today };
  await settings.set('last_daily_run', today);
  const out = {};
  const step = async (rule, fn) => {
    out[rule] = await automation.run(rule, 'daily', null, fn);
  };

  await step('automation_estimate_followups', async () => {
    const expired = await estimates.expireOld();
    const waiting = await db.prepare("SELECT id, estimate_number FROM estimates WHERE status = 'sent' AND sent_at <= ?").all(fmt.addDays(today, -3) + ' 23:59:59');
    if (waiting.length) await automation.notifyPermission(['estimates.manage'], 'job_status', { title: `${waiting.length} estimate(s) awaiting a customer decision 3+ days`, body: waiting.slice(0, 8).map((e) => e.estimate_number).join(', '), linkUrl: '/estimates?status=sent' });
    return `${expired} expired, ${waiting.length} follow-ups`;
  });

  await step('automation_maintenance_jobs', async () => {
    const lead = await settings.getInt('maintenance_job_lead_days', 30);
    const visits = await agreements.visitsComingDue(lead);
    const created = [];
    for (const v of visits) created.push(await agreements.createVisitJob(v.id, null));
    // Agreements ending: auto-renew (draft invoice for review) or remind.
    const ending = await agreements.endingWithin(0);
    let renewed = 0;
    for (const a of ending.filter((x) => x.end_date < today)) {
      if (a.auto_renew) {
        const newId = await agreements.renew(a.id, null);
        const inv = await invoices.createForAgreement(newId, null).catch(() => null);
        renewed++;
        await automation.notifyPermission(['agreements.manage'], 'invoice_ready', { title: `Agreement ${a.agreement_number} auto-renewed`, body: inv ? 'A draft renewal invoice is ready for review.' : '', linkUrl: `/agreements/${newId}` });
      } else {
        await db.prepare("UPDATE maintenance_agreements SET status = 'expired' WHERE id = ?").run(a.id);
      }
    }
    const soon = await agreements.endingWithin(30);
    if (created.length) await automation.notifyPermission(['jobs.manage', 'agreements.manage'], 'job_status', { title: `${created.length} maintenance visit job(s) ready to schedule`, linkUrl: '/jobs?status=ready_to_schedule' });
    if (soon.length) await automation.notifyPermission(['agreements.manage'], 'job_status', { title: `${soon.length} maintenance agreement(s) end within 30 days`, linkUrl: '/agreements' });
    return `${created.length} visit jobs, ${renewed} renewed, ${soon.length} ending soon`;
  });

  await step('automation_overdue_invoice_alerts', async () => {
    const overdue = await db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(total_cents - amount_paid_cents - credited_cents), 0) AS amt FROM invoices WHERE status IN ('issued','partial') AND due_date < ?").get(today);
    if (Number(overdue.c)) await automation.notifyPermission(['accounting.view', 'invoices.manage'], 'invoice_ready', { title: `${overdue.c} overdue invoice(s): ${fmt.money(overdue.amt)}`, linkUrl: '/invoices?overdue=1' });
    return `${overdue.c} overdue`;
  });

  await step('automation_customer_payment_reminders', async () => {
    const base = process.env.APP_BASE_URL || process.env.URL || '';
    const company = await settings.get('company_name', 'Our team');
    let sent = 0;
    for (const days of [7, 14, 30]) {
      const rows = await db
        .prepare("SELECT i.*, c.name, c.email FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('issued','partial') AND i.due_date = ?")
        .all(fmt.addDays(today, -days));
      for (const i of rows) {
        if (!i.email) continue;
        const bal = i.total_cents - i.amount_paid_cents - i.credited_cents;
        await messaging.send({ channel: 'email', to: i.email, subject: `Reminder: invoice ${i.invoice_number} is past due`, body: `Hi ${i.name}, invoice ${i.invoice_number} from ${company} for ${fmt.money(bal)} was due ${fmt.d(i.due_date)}.${base ? ` View it: ${base}/i/${i.public_token}` : ''} If you've already paid, thank you - please ignore this.`, relatedType: 'invoice', relatedId: i.id });
        sent++;
      }
    }
    return `${sent} reminder(s)`;
  });

  await step('automation_certification_alerts', async () => {
    const certs = await db.prepare('SELECT c.*, m.name FROM certifications c JOIN members m ON m.id = c.member_id WHERE m.active = 1 AND c.expires_on IN (?, ?, ?)').all(fmt.addDays(today, 30), fmt.addDays(today, 7), today);
    for (const c of certs) await notifications.notify(c.member_id, 'certification', { title: `${c.name} expires ${fmt.d(c.expires_on)}`, body: 'Please renew and send the office a copy.', linkUrl: '/employee' });
    if (certs.length) await automation.notifyPermission(['employees.manage'], 'certification', { title: `${certs.length} certification(s) expiring`, body: certs.map((c) => `${c.name} (${fmt.d(c.expires_on)})`).slice(0, 5).join('; '), linkUrl: '/manage' });
    const tools = await db.prepare('SELECT COUNT(*) AS c FROM assets WHERE status = ? AND next_service_on = ?').get('in_service', today);
    if (Number(tools.c)) await automation.notifyPermission(['assets.manage'], 'certification', { title: `${tools.c} tool(s) due for calibration/service today`, linkUrl: '/assets' });
    return `${certs.length} certification alerts`;
  });

  await step('automation_training_alerts', async () => {
    const s = await trainingCenter.sync();
    const overdue = await db.prepare("SELECT ta.member_id, t.title FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id JOIN members m ON m.id = ta.member_id WHERE m.active = 1 AND ta.status <> 'passed' AND ta.due_at IS NOT NULL AND substr(ta.due_at, 1, 10) = ?").all(fmt.addDays(today, -1));
    for (const o of overdue) await notifications.notify(o.member_id, 'training_assigned', { title: `Training overdue: ${o.title}`, linkUrl: '/training/mine' });
    for (const r of await db.prepare("SELECT ta.member_id, t.title FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id WHERE ta.status = 'not_started' AND substr(ta.assigned_at, 1, 10) = ?").all(today)) {
      await notifications.notify(r.member_id, 'training_assigned', { title: `New required training: ${r.title}`, linkUrl: '/training/mine' });
    }
    return `${s.assigned} assigned, ${s.renewed} renewals, ${overdue.length} overdue`;
  });

  await step('automation_recurring_expense_alerts', async () => {
    const due = await expenses.dueRecurring(today);
    if (due.length) await automation.notifyPermission(['expenses.manage'], 'invoice_ready', { title: `${due.length} recurring expense(s) due to post`, body: due.map((d) => d.payee).slice(0, 6).join(', '), linkUrl: '/expenses#recurring' });
    return `${due.length} due`;
  });

  await automation.record('daily_run', 'daily', null, `${origin}: ${JSON.stringify(out).slice(0, 400)}`);
  return { today, results: out };
}

module.exports = { runDaily };
