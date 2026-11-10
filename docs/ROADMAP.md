# Phase 2 – Development roadmap

The work is ordered by dependency: the foundation first, then the money flow (job → inventory → invoice → ledger), then the modules that build on it.

| Stage | Module | Depends on | Status |
| --- | --- | --- | --- |
| 1 | Migrations, configurable roles and permissions, settings, audit log | – | **Done** |
| 1 | Three portals (Employee / Customer Service / Management) with permission-driven navigation | RBAC | **Done** |
| 1 | CRM: customers, properties, equipment, communication log, search, dedupe | – | **Done** |
| 1 | Service requests + Wix intake API | CRM | **Done** (the Wix side needs your site; see WIX_INTEGRATION.md) |
| 1 | Jobs: all 16 statuses, status history, notes, photos, signature, equipment links | CRM | **Done** |
| 1 | Scheduling & dispatch: crew, lead, truck, conflict detection, drag-and-drop board | Jobs | **Done** (route optimisation not done) |
| 1 | Inventory: warehouse + trucks, receive/transfer/count, moving-average cost, low-stock alerts, job usage, parts requests | Jobs | **Done** |
| 1 | Time clock: in/out, breaks, GPS at clock events, weekly OT, approvals, corrections, payroll CSV | Jobs | **Done** |
| 1 | Invoices & payments: from job, draft → issued → partial → paid, void with reversal, A/R aging | Jobs, Ledger | **Done** |
| 1 | Double-entry ledger, chart of accounts, manual entries/reversals, P&L, balance sheet, trial balance, cash flow, sales tax | – | **Done** |
| 1 | Job costing + profitability by job / technician / type, labor utilization | Jobs, Time, Inventory | **Done** |
| 1 | Management dashboard (all figures computed from transactions) | All above | **Done** |
| 1 | Automation rules (configurable, logged) + email/SMS outbox | Notifications | **Done** (providers need credentials) |
| 2 | **Estimates / proposals**: line items, good/better/best options, PDF, e-sign approval, convert to job, change orders | Jobs, Invoices | Next |
| 2 | **Purchasing**: vendors, purchase orders, approvals, receiving (partial/backorder), vendor bills (A/P), bill payments | Inventory, Ledger | Next |
| 2 | **Expenses**: categorized expenses with receipt upload, posting to the ledger, recurring expenses | Ledger | Next (manual journal entries cover this today) |
| 2 | **Maintenance agreements**: plans, covered equipment, visit schedule, auto-generated jobs, renewals, deferred revenue | Jobs, Invoices | Next |
| 3 | Payroll: pay runs from approved time, bonuses/commissions/reimbursements, provider integration (Gusto, ADP, QuickBooks Payroll) | Time | Planned; needs a provider choice and API credentials |
| 3 | Training center extensions: categories, required courses by role, expirations, company-wide completion matrix | Training (existing) | Planned |
| 3 | Documents center: link documents to customers, jobs and employees with category search | Documents (existing) | Planned |
| 3 | PTO / sick leave requests, announcements, employee messaging | Employees | Planned |
| 3 | Customer self-service portal (the `customer` role exists): invoices, pay online, request service | Invoices, payments provider | Planned |
| 4 | Integrations: card payments (Stripe), accounting export (QuickBooks/Xero), route optimisation, MFA (TOTP), password-reset email | Providers | Planned; needs credentials |
| 4 | Scheduled jobs (nightly): overdue-invoice notices, cert reminders, maintenance due, low-stock digest | Netlify Scheduled Functions | Planned (cert reminders are a button today) |
