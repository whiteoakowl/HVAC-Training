# HVAC Business Portal

An all-in-one management system for an HVAC company: an employee portal for field technicians, a customer service portal for office staff, and a management portal with dashboards and accounting. These sit alongside the original training portal (events, training courses with quizzes, member directory, notifications, chat, documents), which is unchanged.

Node / Express / EJS on Postgres (Supabase), or SQLite for local development. Deployed as a single Netlify Function.

* **docs/AUDIT.md**: Phase 1 audit of the pre-upgrade app (stack, bugs, security fixes)
* **docs/ROADMAP.md**: what's built and what's next
* **docs/IMPLEMENTATION_LOG.md**: details, tests, known limitations, required credentials
* **docs/WIX_INTEGRATION.md**: connecting the Wix website's forms

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
| `instructor@hvactraining.test`, `student@hvactraining.test` | Training Instructor / Trainee (original roles) | Training portal |

## Modules

| Area | Routes |
| --- | --- |
| Employee portal | `/employee` (my day), `/employee/jobs`, `/employee/time`, `/employee/truck`, `/employee/parts` |
| Customer service | `/service`, `/customers`, `/requests` |
| Operations | `/jobs`, `/jobs/:id`, `/dispatch`, `/inventory`, `/trucks`, `/inventory/parts-requests` |
| Management | `/manage`, `/manage/reports`, `/manage/timesheets`, `/manage/employees`, `/invoices`, `/accounting` (+ reports) |
| Admin | `/portal/members` (users), `/admin/roles`, `/admin/settings`, `/admin/audit` |
| Training portal (original) | `/portal`, `/events`, `/training/mine`, `/member-directory`, `/forums`, `/documents`, `/notifications` |
| Website API | `POST /api/integrations/wix/service-request` |

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
   * Optional: `WIX_WEBHOOK_SECRET`, `RESEND_API_KEY` + `MAIL_FROM`, `TWILIO_*` (see docs/IMPLEMENTATION_LOG.md).
3. Redeploy. On first boot, migrations upgrade the existing database in place. Demo *business* data is never loaded in production.
4. Sign in as the owner. Then:
   * In **Company Settings**: set the company name, labor rate, tax rate and terms; turn **off** public registration; review the automations.
   * In **Users & Roles**: create your staff accounts.
   * In **Trucks**: add your trucks.
   * In **Inventory**: add your items and receive opening stock.

Netlify Functions cap request bodies at about 6 MB, so larger uploads fail there. Job photos are limited to 8 MB each in the app, but a single upload request must also fit under that 6 MB cap.
