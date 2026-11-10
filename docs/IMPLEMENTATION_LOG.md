# Implementation log

## Built-in bookkeeping (QuickBooks-style, no integration)

No QuickBooks or Xero connection is planned; the books live in the app. Migration `006_banking_and_books` adds:
* account subtypes (bank, credit card) and registers
* bank statement import with categorization rules
* reconciliation
* a books-closed date that every posting checks

Pages:
* `/accounting`: overview
* `/accounting/accounts`: chart of accounts; each account opens its register
* `/accounting/banking`: accounts, transfers, rules
* `/accounting/banking/:id`: import a statement, review lines (Match / Add / Exclude, with undo), reconcile
* `/accounting/reconcile/:id`: reconciliation worksheet
* `/invoices/statement/:customer`: customer statement
* New reports: General Ledger, Sales by Customer, Expenses by Vendor/Payee

Tests: `test/books.test.js` (6 scenarios). **48 tests pass on SQLite, and the same suites pass on Postgres 16.**


## Built-in website builder (replaces the Wix integration)

The Wix integration is removed: the webhook endpoint, `WIX_WEBHOOK_SECRET` and the Wix guide are gone. The company website is now built and hosted by this app.

* **Builder (`/website`, permission `website.manage`; Owner, General Manager and Office Manager by default):**
  * **Pages:** create, rename, change address, menu order (drag), show/hide in menu, SEO title and description.
  * **Sections, edited with a live preview:** announcement bar, hero banner with photo and buttons, text, image + text, services grid, call to action, testimonials, FAQ, photo gallery, service area, contact details with map, service request form, spacer.
  * **Editing tools:**
    * Drag to reorder, duplicate, move up or down, delete.
    * Click a section in the preview to edit it.
    * Preview at desktop, tablet or phone width.
  * **Drafts and versions:** edits are saved to a draft. **Publish** makes them live and keeps a version; you can restore an earlier version or discard unpublished edits.
  * **Look & feel:** logo, brand and accent colors, font style, header button, emergency phone, hours, footer text, social links.
  * **Image library:** PNG, JPG, GIF or WebP, checked by file content; SVG is refused. An image can't be deleted while a page uses it.
  * **Text placeholders:** `{{company_name}}`, `{{company_phone}}` and `{{emergency_phone}}` fill in from Company Settings.
* **Public site:** mobile-first, served at `/` and `/<page-address>`.
  * Request forms create the customer (deduplicated) and a Service Request with source "website", notifying customer service.
  * The forms have a spam honeypot and a rate limit.
  * App addresses (`/jobs`, `/login`, ...) can't be used as page addresses.
* **Starter pages:** Home, Services, Maintenance Plans, About, Contact and Request Service are created as **drafts**. [Bracketed] placeholders mark text to replace, such as reviews and service area. Until the Home page is published, `/` goes to the staff login, as before.
* **Tests:** `test/website.test.js`, 6 scenarios:
  1. Only website managers can use the builder.
  2. Draft vs. published; escaped text.
  3. Unsafe links stripped.
  4. Section reorder, duplicate, move and delete, and repeating items.
  5. Reserved addresses refused, the menu, hide/publish, and version history.
  6. Image type checks and in-use protection, theme colors (bad values rejected), taking the site offline.

  The workflow test now starts from a website form submission. **42 tests pass on SQLite, and the same suites pass on Postgres 16.**


## Dates and times: US format, Eastern Time (New York)

* **Display format.** Every date shows as MM/DD/YYYY (e.g. 12/15/1984) and every time as a 12-hour clock (2:30 PM). This covers every page, customer-facing estimates and invoices, pay stubs, emails and texts, notifications, CSV exports, and dates inside ledger memos and audit details. A footer note states the timezone, including standard/daylight time (EST/EDT).
* **Timezone.** It is Eastern Time, America/New_York; migration `004_eastern_time` sets it on existing databases. `APP_TIMEZONE` can still override it.
* **What's stored.** The database still stores ISO text (`YYYY-MM-DD HH:MM:SS`) in New York local time, so sorting, date ranges and comparisons keep working. Date pickers use the browser's native control, which US browsers already show as MM/DD/YYYY.
* **Tests.** The smoke test now fails if any page, for any role, shows a YYYY-MM-DD date or a 24-hour time. A stage 2 test re-checks every invoice, estimate, job, payroll run, purchase order, bill, agreement and customer page after a full day of activity.


## Stage 2 (second change): remaining modules

Migration `003_stage2_modules` adds new tables and columns only. It was tested on SQLite and on Postgres 16, including upgrading a copy of a database created by the original app.

**What was added** (see ROADMAP.md for the full list):
* Estimates with customer e-signature, revisions and deposits.
* Change orders.
* Credits and refunds.
* Vendors, purchase orders with approval and partial receiving, vendor bills, A/P.
* Expenses and recurring expenses.
* Maintenance plans and agreements.
* Payroll runs and pay stubs.
* Time off.
* Announcements, employee messaging, end-of-day reports.
* Job checklists and inspection forms.
* Tools and equipment.
* Documents attached to records.
* Training center: categories, renewals, required courses by role, completion matrix.
* Customer self-service portal.
* Two-step verification, password reset, forced temporary-password change.
* Company timezone.
* Daily scheduled automations.
* Dashboard and report additions.

**New accounts:**
* 2050 Goods Received Not Invoiced
* 2400 Credit Card Payable
* 4910 Customer Credits
* 6010 Payroll Taxes
* 6050 Employee Reimbursements

**New permissions:** estimates, purchasing (manage and approve), bills, expenses, agreements, payroll (view and manage), time-off approval, announcements, messages, end-of-day reports, checklists, assets, customer portal. Each is granted to sensible default roles and editable in Role Permissions.

**Controls built in:**
* Purchase orders, payroll, time off and timesheets can't be approved by the person who created or requested them.
* Payroll needs a second approver before it can be posted.
* Recurring expenses and auto-renewals never post money on their own; renewals produce draft invoices only.
* Customer payment reminders are off by default and need an email provider.

**Tests:** `test/stage2.test.js` covers 12 scenarios, each checked against the ledger:
1. Estimate → customer signs on the public page → job created automatically.
2. Deposit invoice → change order signed on site → checklist → final invoice deducts the deposit and carries the discount → paid → credit and refund.
3. Purchase order: self-approval refused, second-person approval, partial receipt and backorder, over-receipt refused, bill clears GRNI, paid.
4. Expenses, a void, and a recurring expense the daily run does not post.
5. Agreement visit job auto-created, covered visit not invoiced, agreement invoice to 4200.
6. Payroll: regular, overtime and PTO computed; preparer can't approve; posted; stubs private.
7. Time off with balances, messaging permissions, announcements.
8. Customer portal isolation.
9. Record-document permissions.
10. Two-step login and forced password change.
11. Required training by role.
12. Trial balance and balance sheet balance at the end.

The smoke test now also crawls as the customer login. **35 tests pass on SQLite, and the same suites pass on Postgres 16.**

**Known limitations, Stage 2:**
* The payroll module records pay but does not calculate tax withholding or pay anyone; enter withholdings from your payroll provider.
* Overtime is weekly only.
* Paid leave balances are set by a manager; there is no automatic accrual.
* Only one bill per purchase-order receipt batch is supported. A bill always covers everything received and not yet billed.
* SQLite (local development only) stores `created_at` defaults in UTC. Postgres uses the company timezone throughout.

## Stage 1

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
* **Service requests** (`/requests`)
  * Office intake, the website's request forms and the customer portal share one code path.
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
| New service request (office, website or portal) | Notify everyone with `requests.manage` | on |
| New service request | Email/SMS confirmation to the customer (needs a provider) | **off** |
| Technician added to a job | Notify the technician | on |
| Job completed | Create a **draft** invoice and notify billing | on |
| Material used brings stock to its minimum | Notify everyone with `inventory.manage` | on |
| Always on (not toggles): materials deducted from truck stock, payment updates the invoice balance and job status, job status history, ledger postings | | |

### Testing (`npm test`)

* `test/smoke.test.js`: logs in as each of the 13 seeded roles, opens every nav link (must return 200), then every internal link on those pages (must not be 404, 403 or 500).
* `test/workflow.test.js`: the full chain from the brief, checked step by step with database and ledger assertions.
  * Website form submission → customer created → spam honeypot ignored → second request matched to the same customer.
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

### Credentials and configuration you need to provide

| Variable | Purpose | Required? |
| --- | --- | --- |
| `DATABASE_URL` | Supabase Postgres (transaction pooler, port 6543) | Yes, for production |
| `SESSION_SECRET` | Signs login cookies | **Yes** |
| `RESEND_API_KEY`, `MAIL_FROM` | Customer emails | Optional |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Customer texts | Optional |
| `COOKIE_SECURE=1` | Adds the `Secure` flag to the session cookie | Recommended once verified on Netlify |
| `SEED_DEMO=1` | Loads demo business data (**never on production**) | No |
