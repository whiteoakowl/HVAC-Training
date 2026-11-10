// Payroll runs (restricted to payroll.view / payroll.manage).
const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const payroll = require('../utils/payroll');
const notifications = require('../utils/notifications');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

router.use(requireAuth, requirePermission('payroll.view', 'payroll.manage'));

router.get('/', async (req, res) => {
  const today = fmt.today();
  const ws = fmt.weekStart(today);
  res.render('payroll-list', { title: 'Payroll', runs: await payroll.listRuns(), defaults: { start: fmt.addDays(ws, -14), end: fmt.addDays(ws, -1), pay: fmt.addDays(ws, 4) } });
});

router.post('/', requirePermission('payroll.manage'), action(async (req, res) => {
  const id = await payroll.createRun({ periodStart: req.body.period_start, periodEnd: req.body.period_end, payDate: req.body.pay_date }, req.member.id);
  await audit.log(req, 'payroll.create', 'payroll_run', id);
  flash(res, `/payroll/${id}`, 'notice', 'Draft payroll prepared from approved time and leave. Enter bonuses, reimbursements and the withholdings from your payroll provider.');
}, '/payroll'));

async function load(req, res, next) {
  const run = await payroll.getRun(req.params.id);
  if (!run) return res.status(404).render('404', { title: 'Not Found' });
  req.run = run;
  next();
}
const back = (req) => `/payroll/${req.params.id}`;

router.get('/:id', load, (req, res) => {
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`payroll-${req.run.period_start}-${req.run.period_end}.csv`);
    return res.send(fmt.csv(req.run.items, [
      { label: 'Employee', value: 'name' }, { label: 'Pay type', value: 'pay_type' }, { label: 'Rate', value: (i) => fmt.centsInput(i.rate_cents) },
      { label: 'Regular hours', value: (i) => fmt.hours(i.regular_minutes) }, { label: 'Overtime hours', value: (i) => fmt.hours(i.overtime_minutes) }, { label: 'PTO hours', value: 'pto_hours' },
      { label: 'Regular pay', value: (i) => fmt.centsInput(i.regular_pay_cents) }, { label: 'OT pay', value: (i) => fmt.centsInput(i.overtime_pay_cents) }, { label: 'PTO pay', value: (i) => fmt.centsInput(i.pto_pay_cents) },
      { label: 'Salary', value: (i) => fmt.centsInput(i.salary_pay_cents) }, { label: 'Bonus', value: (i) => fmt.centsInput(i.bonus_cents) }, { label: 'Commission', value: (i) => fmt.centsInput(i.commission_cents) },
      { label: 'Gross', value: (i) => fmt.centsInput(i.gross_cents) }, { label: 'Withholding', value: (i) => fmt.centsInput(i.withholding_cents) }, { label: 'Deductions', value: (i) => fmt.centsInput(i.deduction_cents) },
      { label: 'Reimbursement', value: (i) => fmt.centsInput(i.reimbursement_cents) }, { label: 'Net', value: (i) => fmt.centsInput(i.net_cents) },
    ]));
  }
  res.render('payroll-run', { title: `Payroll ${req.run.period_start} to ${req.run.period_end}`, run: req.run });
});

router.post('/:id/items/:itemId', requirePermission('payroll.manage'), load, action(async (req, res) => {
  await payroll.updateItem(req.run.id, req.params.itemId, req.body);
  await audit.log(req, 'payroll.item', 'payroll_run', req.run.id, { itemId: req.params.itemId });
  flash(res, back(req), 'notice', 'Saved.');
}, back));

router.post('/:id/approve', requirePermission('payroll.manage'), load, action(async (req, res) => {
  await payroll.approve(req.run.id, req.member.id);
  await audit.log(req, 'payroll.approve', 'payroll_run', req.run.id);
  flash(res, back(req), 'notice', 'Approved. Process it with your payroll provider, then post it.');
}, back));

router.post('/:id/post', requirePermission('payroll.manage'), load, action(async (req, res) => {
  await payroll.post(req.run.id, req.member.id);
  await audit.log(req, 'payroll.post', 'payroll_run', req.run.id, { gross: req.run.gross_cents, net: req.run.net_cents });
  for (const i of req.run.items) await notifications.notify(i.member_id, 'timesheet', { title: `Pay stub available (${req.run.pay_date})`, linkUrl: `/employee/pay/${i.id}` });
  flash(res, back(req), 'notice', 'Payroll posted to the ledger. Employees can now see their pay stubs.');
}, back));

router.post('/:id/void', requirePermission('payroll.manage'), load, action(async (req, res) => {
  await payroll.voidRun(req.run.id, req.body.reason, req.member.id);
  await audit.log(req, 'payroll.void', 'payroll_run', req.run.id, { reason: req.body.reason });
  flash(res, back(req), 'notice', 'Payroll run voided.');
}, back));

module.exports = router;
