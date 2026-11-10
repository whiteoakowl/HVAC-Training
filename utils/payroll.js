// Payroll runs: compute gross pay from APPROVED time (weekly overtime at
// 1.5x above the configured threshold), approved paid time off, salary,
// plus bonuses/commissions/reimbursements entered by payroll staff.
// Withholdings and deductions are entered from your payroll provider's
// register - this app does not calculate payroll taxes or file anything.
// Posting the run records it in the ledger:
//   Dr 6000 Payroll Expense (gross) + Dr 6050 Reimbursements
//   Cr 2300 Payroll Liabilities (withholdings + deductions) + Cr 1000 Cash (net)
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');
const accounting = require('./accounting');
const timeclock = require('./timeclock');

const PAID_LEAVE = ['vacation', 'sick', 'personal'];

function days(from, to) {
  return Math.round((fmt.parseTs(to + ' 00:00:00') - fmt.parseTs(from + ' 00:00:00')) / 86400000) + 1;
}

async function listRuns() {
  return db.prepare('SELECT r.*, m.name AS "createdByName", (SELECT COUNT(*) FROM payroll_items i WHERE i.run_id = r.id) AS "people" FROM payroll_runs r LEFT JOIN members m ON m.id = r.created_by ORDER BY r.period_end DESC, r.id DESC').all();
}

async function getRun(id) {
  const run = await db.prepare('SELECT r.*, cb.name AS "createdByName", ab.name AS "approvedByName" FROM payroll_runs r LEFT JOIN members cb ON cb.id = r.created_by LEFT JOIN members ab ON ab.id = r.approved_by WHERE r.id = ?').get(id);
  if (!run) return null;
  run.items = await db.prepare('SELECT i.*, m.name, m.email FROM payroll_items i JOIN members m ON m.id = i.member_id WHERE i.run_id = ? ORDER BY m.name').all(id);
  run.pendingTime = (await db.prepare("SELECT COUNT(*) AS c FROM time_entries WHERE status IN ('pending','open') AND clock_in >= ? AND clock_in < ?").get(run.period_start + ' 00:00:00', fmt.addDays(run.period_end, 1) + ' 00:00:00')).c;
  return run;
}

function computeNet(i) {
  const gross = i.regular_pay_cents + i.overtime_pay_cents + i.pto_pay_cents + i.salary_pay_cents + i.bonus_cents + i.commission_cents;
  return { gross, net: gross - i.withholding_cents - i.deduction_cents + i.reimbursement_cents };
}

async function recalcRun(tx, id) {
  const t = await tx.prepare('SELECT COALESCE(SUM(gross_cents),0) AS g, COALESCE(SUM(withholding_cents),0) AS w, COALESCE(SUM(deduction_cents),0) AS d, COALESCE(SUM(reimbursement_cents),0) AS r, COALESCE(SUM(net_cents),0) AS n FROM payroll_items WHERE run_id = ?').get(id);
  await tx.prepare('UPDATE payroll_runs SET gross_cents = ?, withholding_cents = ?, deduction_cents = ?, reimbursement_cents = ?, net_cents = ? WHERE id = ?').run(Number(t.g), Number(t.w), Number(t.d), Number(t.r), Number(t.n), id);
}

async function createRun({ periodStart, periodEnd, payDate }, memberId) {
  const from = fmt.dateOnly(periodStart);
  const to = fmt.dateOnly(periodEnd);
  const pay = fmt.dateOnly(payDate);
  if (!from || !to || !pay) throw new Error('Enter the pay period and pay date.');
  if (to < from) throw new Error('The period end must be after its start.');
  if (days(from, to) > 31) throw new Error('A pay period can be at most 31 days.');
  const overlap = await db.prepare("SELECT id FROM payroll_runs WHERE status <> 'void' AND period_start <= ? AND period_end >= ?").get(to, from);
  if (overlap) throw new Error(`Payroll run #${overlap.id} already covers part of this period.`);
  const threshold = (await settings.getInt('overtime_weekly_hours', 40)) * 60;
  const hoursPerDay = await settings.getInt('pto_hours_per_day', 8);
  const people = await db
    .prepare("SELECT m.id, m.name, ep.pay_type, ep.pay_rate_cents FROM members m JOIN employee_profiles ep ON ep.member_id = m.id WHERE m.active = 1 AND ep.pay_rate_cents > 0 ORDER BY m.name")
    .all();
  if (!people.length) throw new Error('No employees have a pay rate set. Add pay rates under Employees first.');
  const entries = (await timeclock.entries({ from: from + ' 00:00:00', to: fmt.addDays(to, 1) + ' 00:00:00', status: 'approved' }));
  const leave = await db
    .prepare("SELECT * FROM time_off_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?")
    .all(to, from);
  return db.withTransaction(async (tx) => {
    const info = await tx.prepare('INSERT INTO payroll_runs (period_start, period_end, pay_date, created_by) VALUES (?, ?, ?, ?)').run(from, to, pay, memberId);
    const runId = info.lastInsertRowid;
    for (const p of people) {
      const mine = entries.filter((e) => e.member_id === p.id);
      const weeks = {};
      for (const e of mine) {
        const w = fmt.weekStart(e.clock_in);
        weeks[w] = (weeks[w] || 0) + e.workedMinutes;
      }
      let reg = 0;
      let ot = 0;
      for (const m of Object.values(weeks)) {
        reg += Math.min(m, threshold);
        ot += Math.max(0, m - threshold);
      }
      // Paid leave hours falling inside the period (pro-rated by days).
      let pto = 0;
      for (const l of leave.filter((x) => x.member_id === p.id && PAID_LEAVE.includes(x.kind))) {
        const total = days(l.start_date, l.end_date);
        const inside = days(l.start_date > from ? l.start_date : from, l.end_date < to ? l.end_date : to);
        pto += Math.round(((Number(l.hours) || total * hoursPerDay) * inside) / total * 100) / 100;
      }
      const item = { regular_pay_cents: 0, overtime_pay_cents: 0, pto_pay_cents: 0, salary_pay_cents: 0, bonus_cents: 0, commission_cents: 0, withholding_cents: 0, deduction_cents: 0, reimbursement_cents: 0 };
      if (p.pay_type === 'salary') {
        item.salary_pay_cents = Math.round((p.pay_rate_cents * days(from, to)) / 365);
      } else {
        item.regular_pay_cents = Math.round((reg / 60) * p.pay_rate_cents);
        item.overtime_pay_cents = Math.round((ot / 60) * p.pay_rate_cents * 1.5);
        item.pto_pay_cents = Math.round(pto * p.pay_rate_cents);
      }
      if (p.pay_type !== 'salary' && !reg && !ot && !pto) continue;
      const { gross, net } = computeNet(item);
      await tx
        .prepare(`INSERT INTO payroll_items (run_id, member_id, pay_type, rate_cents, regular_minutes, overtime_minutes, pto_hours, regular_pay_cents, overtime_pay_cents, pto_pay_cents, salary_pay_cents, gross_cents, net_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, p.id, p.pay_type, p.pay_rate_cents, reg, ot, pto, item.regular_pay_cents, item.overtime_pay_cents, item.pto_pay_cents, item.salary_pay_cents, gross, net);
    }
    await recalcRun(tx, runId);
    return runId;
  });
}

async function updateItem(runId, itemId, d) {
  return db.withTransaction(async (tx) => {
    const run = await tx.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
    if (!run || run.status !== 'draft') throw new Error('Only draft payroll runs can be edited.');
    const i = await tx.prepare('SELECT * FROM payroll_items WHERE id = ? AND run_id = ?').get(itemId, runId);
    if (!i) throw new Error('Line not found.');
    const vals = {};
    for (const k of ['bonus', 'commission', 'reimbursement', 'withholding', 'deduction']) {
      const c = fmt.toCents(d[k]);
      if (c !== null && c < 0) throw new Error('Amounts cannot be negative.');
      vals[k + '_cents'] = c || 0;
    }
    const next = { ...i, ...vals };
    const { gross, net } = computeNet(next);
    if (net < 0) throw new Error('Withholdings and deductions exceed gross pay.');
    await tx
      .prepare('UPDATE payroll_items SET bonus_cents = ?, commission_cents = ?, reimbursement_cents = ?, withholding_cents = ?, deduction_cents = ?, gross_cents = ?, net_cents = ?, notes = ? WHERE id = ?')
      .run(vals.bonus_cents, vals.commission_cents, vals.reimbursement_cents, vals.withholding_cents, vals.deduction_cents, gross, net, fmt.clean(d.notes, 500), itemId);
    await recalcRun(tx, runId);
  });
}

async function approve(runId, memberId) {
  const run = await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
  if (!run || run.status !== 'draft') throw new Error('Only draft runs can be approved.');
  if (run.created_by === memberId) throw new Error("Someone other than the preparer must approve payroll.");
  if (!(await db.prepare('SELECT COUNT(*) AS c FROM payroll_items WHERE run_id = ?').get(runId)).c) throw new Error('This run has no employees.');
  await db.prepare("UPDATE payroll_runs SET status = 'approved', approved_by = ?, approved_at = now_text() WHERE id = ?").run(memberId, runId);
}

async function post(runId, memberId) {
  return db.withTransaction(async (tx) => {
    const run = await tx.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
    if (!run || run.status !== 'approved') throw new Error('Approve the run before posting it.');
    const liabilities = run.withholding_cents + run.deduction_cents;
    const entryId = await accounting.post(tx, {
      date: run.pay_date, memo: `Payroll ${run.period_start} to ${run.period_end}`, sourceType: 'payroll', sourceId: run.id, memberId,
      lines: [{ code: '6000', debit: run.gross_cents }, { code: '6050', debit: run.reimbursement_cents }, { code: '2300', credit: liabilities }, { code: '1000', credit: run.net_cents }],
    });
    await tx.prepare("UPDATE payroll_runs SET status = 'posted', posted_at = now_text(), journal_entry_id = ? WHERE id = ?").run(entryId, runId);
    return entryId;
  });
}

async function voidRun(runId, reason, memberId) {
  if (!fmt.clean(reason)) throw new Error('A reason is required.');
  return db.withTransaction(async (tx) => {
    const run = await tx.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
    if (!run || run.status === 'void') throw new Error('Run not found or already void.');
    if (run.journal_entry_id) await accounting.reverse(tx, run.journal_entry_id, { memo: `Void payroll #${runId}: ${reason}`, memberId });
    await tx.prepare("UPDATE payroll_runs SET status = 'void', notes = COALESCE(notes, '') || ? WHERE id = ?").run(` [Void: ${reason}]`, runId);
  });
}

async function stubsFor(memberId) {
  return db
    .prepare("SELECT i.*, r.period_start, r.period_end, r.pay_date FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id WHERE i.member_id = ? AND r.status = 'posted' ORDER BY r.pay_date DESC")
    .all(memberId);
}

async function stub(memberId, itemId) {
  return db
    .prepare("SELECT i.*, r.period_start, r.period_end, r.pay_date, m.name, ep.employee_number FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id JOIN members m ON m.id = i.member_id LEFT JOIN employee_profiles ep ON ep.member_id = i.member_id WHERE i.id = ? AND i.member_id = ? AND r.status = 'posted'")
    .get(itemId, memberId);
}

async function ytd(memberId, year) {
  return db
    .prepare("SELECT COALESCE(SUM(i.gross_cents),0) AS gross, COALESCE(SUM(i.withholding_cents),0) AS withholding, COALESCE(SUM(i.deduction_cents),0) AS deductions, COALESCE(SUM(i.net_cents),0) AS net FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id WHERE i.member_id = ? AND r.status = 'posted' AND r.pay_date >= ? AND r.pay_date <= ?")
    .get(memberId, `${year}-01-01`, `${year}-12-31`);
}

module.exports = { listRuns, getRun, createRun, updateItem, approve, post, voidRun, stubsFor, stub, ytd };
