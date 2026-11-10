# Implementation log

## Stage 1 (this change): foundation and core operations

### What was built

**Foundation**
* `db/migrate.js` with versioned migrations. Each runs once, inside a transaction, recorded in `schema_migrations`, and on Postgres under an advisory lock so concurrent cold starts are safe. `db/schema.sql` stays as the original baseline.
* Migration `001_foundation_rbac`:
  * 14 roles (the original `admin`, `instructor` and `student` keys keep their meaning: Owner, Training Instructor, Trainee) and 41 permissions, configurable at **Admin → Role Permissions**.
  * `members` is rebuilt (SQLite) or altered (Postgres) so `role` references `roles(key)`; every row and id is preserved. Login-lockout columns are added.
  * New tables: `employee_profiles`, `certifications`, `settings`, `audit_log`.
* Migration `002_business_core`: CRM, service requests, trucks, inventory, jobs and their sub-tables, time clock, chart of accounts (29 accounts), journal, invoices, payments, outbound messages, automation runs.
* Every permission check goes through `req.can()` / `requirePermission()`. Owner-level roles can only be granted, and owner accounts only edited, by an owner.

**Portals.** Home sends each role to its own portal: Management `/manage`, Customer Service `/service`, Employee `/employee`, training-only roles `/portal`. The sidebar is built from permissions, so nobody sees a link they can't open; the smoke test checks this for every role.

**Modules.** For each module: where it lives, then what it does.
* **CRM** (`/customers`)
  * Residential/commercial accounts, multiple properties, equipment records.
  * A communication log with follow-ups, a service-history timeline, balances and photos.
  * Search by name, phone, email, address, customer #, job # or serial #.
  * Duplicate detection on email and phone.
* **Service requests** (`/requests`, and the `/api/integrations/wix/service-request` endpoint)
  * Office intake and Wix intake share one code path.
  * Retries are idempotent; customer service is notified.
  * A request converts to a job in one click.
* **Jobs** (`/jobs/:id`, mobile-first)
  * All 16 statuses, with history.
  * Technicians can set field statuses only.
  * Notes, photos/receipts/documents (stored in the DB), equipment links, materials from the technician's truck, work performed, and a finger-drawn customer signature.
  * Office tools: crew + lead + truck + schedule with conflict alerts, edit, office statuses, other costs, and job costing.
* **Dispatch board** (`/dispatch`): per-technician columns for a day. Drag a job onto a technician; overlaps are highlighted.
* **Inventory** (`/inventory`, `/trucks`)
  * Items, warehouse and truck locations, per-location minimums and bins.
  * Receive (into A/P or paid from cash), transfer, physical count with shrinkage posting, and a full transaction history with CSV export.
  * Moving-average cost.
  * Negative stock is blocked unless a manager overrides it.
  * Low-stock alerts; parts requests from technicians, with "fulfil to truck".
* **Time clock** (`/employee/time`, `/manage/timesheets`)
  * Clock in (optionally on a job) and out, and breaks.
  * GPS is captured only at the moment of clocking in or out, and only when that setting is on.
  * Weekly overtime above the configured threshold.
  * Manager approval (nobody can approve their own time); correction requests.
  * Payroll CSV export.
* **Invoices** (`/invoices`)
  * Created as a draft from a job: the quoted price, or clocked labor × labor rate plus materials at selling price plus permits.
  * Discount, tax rate, terms and printable layout (Print → Save as PDF).
  * Issuing posts to the ledger.
  * Partial and full payments; job status moves to Invoiced, then Paid.
  * Void (no payments) posts a reversing entry.
  * A/R aging.
* **Accounting** (`/accounting`)
  * Double-entry journal: every entry must balance, and entries are never edited (reversal only).
  * Chart of accounts with balances, and manual entries for expenses, payroll and owner draws.
  * P&L, balance sheet, trial balance, cash flow, A/R aging, sales tax; date filters, CSV export, print-to-PDF.
* **Management dashboard** (`/manage`): revenue (month, year, all time), net profit, expenses, payroll expense, cash, A/R, A/P, overdue and draft invoices, active/completed/scheduled jobs, estimates pipeline, requests, customers, hours, utilization, inventory and truck value, low stock, upcoming maintenance and expiring certifications. All figures are computed from recorded data.
* **Reports** (`/manage/reports`): job profitability by job, technician (multi-tech jobs split evenly) and service type; labor utilization; request → job conversion; CSV export.
* **Employees** (`/manage/employees`): records, pay type and rate (used for labor costing), certifications with expiry highlighting and reminders, and per-employee training, jobs and time.
* **Admin**
  * Role permission matrix and editor.
  * Company settings: company info, labor rate, tax, terms, overtime threshold, GPS, registration, automation toggles, and integration status.
  * Audit log, automation-run history and outbound-message log.

### Workflow automations (each can be toggled in Settings; every run is logged)

| Trigger | Action | Default |
| --- | --- | --- |
| New service request (office or Wix) | Notify everyone with `requests.manage` | on |
| New service request | Email/SMS confirmation to the customer (needs a provider) | **off** |
| Technician added to a job | Notify the technician | on |
| Job completed | Create a **draft** invoice and notify billing | on |
| Material used brings stock to its minimum | Notify everyone with `inventory.manage` | on |
| Always on (not toggles): materials deducted from truck stock, payment updates the invoice balance and job status, job status history, ledger postings | | |

### Testing (`npm test`)

* `test/smoke.test.js`: logs in as each of the 13 seeded roles, opens every nav link (must return 200), then every internal link on those pages (must not be 404, 403 or 500).
* `test/workflow.test.js`: the full chain from the brief, checked step by step with database and ledger assertions.
  * Wix submission → customer created → retry deduped → second request matched to the same customer.
  * CSR converts it to a job; the CSR is blocked from payroll and financials.
  * The dispatcher assigns technician and truck; conflicts are flagged.
  * The technician is blocked from other technicians' jobs and from invoices. They clock in with GPS, can't over-draw or pull from the warehouse, and use one part (truck stock −1, Inventory −cost, COGS +cost). They upload a photo, clock out and complete with a signature.
  * A draft invoice appears with labor and material. Accounting issues it: A/R, revenue and sales tax are checked.
  * An overpayment is refused and voiding with payments is refused. A partial payment, then the full one, leave the invoice and job Paid, cash up and A/R back to its starting point.
  * Trial balance and balance sheet balance; all reports render; job costing is checked.
  * Timesheet approval, plus correction requests on approved time.
  * Privilege escalation blocked, lockout, open redirect blocked, audit-trail coverage.
  * Original trainee features still work.
* `test/migration.test.js`: builds a database with the original schema and data, upgrades it, and checks that every row, id and FK survives, that new roles work, and that re-running is a no-op.
* All of the above pass on **SQLite** and on **Postgres 16**. For Postgres, run `TEST_DATABASE_URL=postgres://... npm test` against an empty database.
* Separately, a copy of a database seeded by the *original* app was upgraded on both SQLite and Postgres, and the original admin and student logins were confirmed working.

### Where Stage 1 stopped / known limitations

* **Not built yet** (see ROADMAP.md stage 2+):
  * Estimates/proposals with e-signature and PDF. Today the job statuses track the estimate pipeline, and the quoted price on a job flows to the invoice.
  * Purchasing, POs, vendors, vendor bills. Today receiving stock posts to A/P, and paying vendors is a manual journal entry.
  * An expense-entry screen with receipt upload. Today: manual journal entries, plus receipts uploaded on jobs.
  * Maintenance agreements; PTO/sick requests; announcements and employee messaging; the customer self-service portal; refunds and credits (an invoice with payments can't be voided yet); route optimisation; MFA; password-reset email (managers can reset passwords); scheduled nightly automations (overdue reminders etc.).
* **PDFs**: invoices and reports use print-friendly layouts (browser Print → Save as PDF). There is no server-side PDF generation.
* **Payroll**: hours, overtime and rates are tracked and exported as CSV. Gross-to-net, withholding, direct deposit and tax filings must go through a payroll provider; that integration is not built. Overtime is weekly only (no daily-OT rules).
* **Accounting**: statements are management reports computed from the ledger. They are not tax returns or reviewed/audited statements. There are no year-end closing entries; the balance sheet shows cumulative "current earnings". Have an accountant review the chart of accounts and the tax settings.
* **Timezone**: timestamps are stored and shown in UTC.
* **Wix**: the API is built and tested. The Wix page code (docs/WIX_INTEGRATION.md) has to be added in your Wix editor.

### Credentials and configuration you need to provide

| Variable | Purpose | Required? |
| --- | --- | --- |
| `DATABASE_URL` | Supabase Postgres (transaction pooler, port 6543) | Yes, for production |
| `SESSION_SECRET` | Signs login cookies | **Yes** |
| `WIX_WEBHOOK_SECRET` | Authenticates the Wix site | For Wix forms |
| `RESEND_API_KEY`, `MAIL_FROM` | Customer emails | Optional |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Customer texts | Optional |
| `COOKIE_SECURE=1` | Adds the `Secure` flag to the session cookie | Recommended once verified on Netlify |
| `SEED_DEMO=1` | Loads demo business data (**never on production**) | No |
