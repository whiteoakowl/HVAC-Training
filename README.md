# HVAC Business Portal

An all-in-one management system for an HVAC company: an employee portal for field technicians, a customer service portal for office staff, and a management portal with dashboards and accounting. Training is part of these portals, not a separate one: employees take their courses from the **Training** tab of the employee portal, and managers build, assign and track courses from the **Training** section of the management side. The original team features (events, member directory, notifications, chat, documents) are unchanged.

Node / Express / EJS on Postgres (Supabase), or SQLite for local development. Deployed as a single Netlify Function.

* **docs/AUDIT.md**: Phase 1 audit of the pre-upgrade app (stack, bugs, security fixes)
* **docs/ROADMAP.md**: what's built and what's next
* **docs/IMPLEMENTATION_LOG.md**: details, tests, known limitations, required credentials
* **Website**: the company's public website is built into the app (Admin → Website); no outside site builder is needed

## Setup

```
npm install
npm run seed   # creates/migrates the schema + demo accounts and demo business data
npm start      # http://localhost:3000
npm test       # smoke + end-to-end workflow + migration tests (SQLite)
TEST_DATABASE_URL=postgres://user:pass@localhost/empty_db npm test   # same suite on Postgres
```

Demo logins all use the password `password123`.

| Login | Role | Lands on |
| --- | --- | --- |
| `admin@hvactraining.test` | Owner / Super Administrator | Management dashboard |
| `gm@hvacdemo.test` | General Manager | Management dashboard |
| `office@hvacdemo.test` | Office Manager | Management dashboard |
| `accounting@hvacdemo.test` | Accounting | Management dashboard |
| `csr@hvacdemo.test` | Customer Service | Service Desk |
| `dispatch@hvacdemo.test` | Dispatcher | Service Desk |
| `servicemgr@hvacdemo.test` | Service Manager | Management dashboard |
| `lead@hvacdemo.test`, `tech@hvacdemo.test`, `installer@hvacdemo.test` | Lead Technician / Technician / Installer | My Day (employee portal) |
| `warehouse@hvacdemo.test` | Warehouse / Inventory Manager | My Day |
| `instructor@hvactraining.test` | Training Instructor (builds courses, assigns training) | My Day, plus the Training management section |
| `student@hvactraining.test` | Trainee | My Day, with the Training tab |
| `customer@hvacdemo.test` | Customer (self-service portal) | My Account (`/my`) |

## Modules

| Area | Routes |
| --- | --- |
| Employee portal | `/employee` (my day), `/employee/jobs`, `/employee/time`, `/employee/truck`, `/employee/parts`, and the tabs `/training/mine`, `/meetings` (list or calendar, join the video call), `/documents`, `/checklists` |
| Customer service | `/service`, `/customers`, `/requests` |
| Operations | `/jobs`, `/jobs/:id`, `/dispatch`, `/inventory`, `/trucks`, `/inventory/parts-requests` |
| Management | `/manage`, `/manage/reports`, `/manage/timesheets`, `/manage/employees`, `/invoices` |
| Bookkeeping (built in, QuickBooks-style) | `/accounting` overview, `/accounting/banking` (statement import, matching, rules, reconciliation), `/accounting/accounts` (registers), reports incl. P&L, balance sheet, general ledger, sales by customer, expenses by vendor |
| Sales & billing | `/estimates`, `/agreements`, `/invoices` (credits, refunds, deposits) |
| Purchasing & costs | `/purchasing`, `/vendors`, `/bills`, `/expenses`, `/payroll`, `/assets` |
| Team Management | `/meetings/manage` (schedule, edit, cancel meetings), `/documents/manage`, `/checklists/manage` (create checklists by topic, see who finished), `/training/center` (completion matrix, required courses by role, renewals), `/training/manage` (build courses, lessons, quizzes; assign to employees) |
| Team | `/announcements`, `/messages`, `/employee/time-off`, `/employee/pay`, `/employee/report`, `/manage/time-off`, `/manage/daily-reports` |
| Customer-facing (no staff login) | `/my` (customer portal), `/e/:token` (approve estimate), `/i/:token` (view invoice) |
| Admin | `/portal/members` (users), `/admin/roles`, `/admin/settings`, `/admin/audit`, `/admin/checklists`, `/account` (password, two-step verification) |
| Team features (original) | `/events`, `/member-directory`, `/forums`, `/documents`, `/notifications` (the old `/portal` address now redirects to each person's home) |
| Public website (built in) | `/` home page and pages like `/services`, `/contact`, `/request-service`; edited at `/website` |

Roles and permissions are configurable (`/admin/roles`). Every page and action checks a permission, not a role name.

## Data

* **Postgres / Supabase** is used whenever `DATABASE_URL` holds a `postgres://` URL.
* **SQLite** is the local fallback, stored at `data/hvac_training.sqlite`.
* Structural changes are versioned migrations in `db/migrations/`. They are applied automatically on startup, exactly once each, and never drop existing data. `db/schema.sql` is the original baseline.
* Money is stored as integer cents. Every financial event posts a balanced double-entry journal entry, and the reports are computed from the ledger.
* Uploaded files (documents, job photos, receipts) are stored in the database, so they persist on serverless hosting.
* **Backups**: use Supabase's automated daily backups / point-in-time recovery (Project → Database → Backups). Take a manual backup before each deploy that adds a migration.

## Deploying to Netlify + Supabase

1. In Supabase, open **Connect** and copy the **Transaction pooler** connection string (port `6543`), with your database password filled in.
2. In Netlify, under **Site configuration → Environment variables**, set:
   * `DATABASE_URL`: the connection string from step 1.
   * `SESSION_SECRET`: a long random string (**required**).
   * `SEED_PASSWORD`: the password for the original demo accounts. **Change or deactivate those accounts** once your real users exist.
   * Optional: `RESEND_API_KEY` + `MAIL_FROM`, `TWILIO_*` (see docs/IMPLEMENTATION_LOG.md).
   * Optional: `APP_TIMEZONE` overrides the timezone in Company Settings.
   * Video meetings use free Jitsi Meet rooms (`meet.jit.si`) with no setup or keys. Managers can paste a Zoom / Google Meet / Teams link instead. A self-hosted Jitsi server can be set in Company Settings.
   * Optional: `APP_BASE_URL` (e.g. `https://yourapp.netlify.app`) is used for links in automated reminder emails. Netlify's `URL` is used if it isn't set.
   * Daily automations run from the scheduled function `netlify/functions/daily.js` (schedule in `netlify.toml`). There is nothing to set up beyond deploying.
3. Redeploy. On first boot, migrations upgrade the existing database in place. Demo *business* data is never loaded in production.
4. Sign in as the owner. Then:
   * In **Company Settings**: set the company name, labor rate, tax rate and terms; turn **off** public registration; review the automations.
   * In **Users & Roles**: create your staff accounts.
   * In **Trucks**: add your trucks.
   * In **Inventory**: add your items and receive opening stock.
   * In **Website**: add your logo, colors and photos, replace the [bracketed] placeholder text with your own, then **Publish** the Home page. Until then, your address goes to the staff login.

Netlify Functions cap request bodies at about 6 MB, so larger uploads fail there. Job photos are limited to 8 MB each in the app, but a single upload request must also fit under that 6 MB cap.
