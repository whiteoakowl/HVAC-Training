# Phase 1 – Audit of the existing application (pre-upgrade)

Audited at commit `e9bb90e` ("Collapse sidebar into a Menu dropdown on phones").

## Stack

| Area | Finding |
| --- | --- |
| Language / framework | Node.js 20+, Express 4, server-rendered EJS views, no front-end build step |
| Database | Postgres (Supabase) when `DATABASE_URL` holds a `postgres://` URL, otherwise SQLite (`better-sqlite3`). Both sit behind one `prepare().get/all/run()` + `withTransaction()` API (`db/postgres.js`, `db/sqlite.js`). |
| Schema management | One `db/schema.sql` with `CREATE TABLE IF NOT EXISTS`, run on every start. **No migration system**, so an existing table could never be changed. |
| Hosting | Netlify. The whole Express app runs as a single function (`netlify/functions/app.js`, `serverless-http`); `public/` is served from the CDN. |
| Auth | Email + bcrypt password; signed-cookie sessions (`cookie-session`) storing only `memberId` |
| Roles | One column, `members.role`, with a CHECK constraint limiting it to `student`, `instructor` or `admin`; a hard-coded rank `student < instructor < admin` |
| Files | Document uploads are stored in the database (`document_files`) so they survive serverless instances |
| Integrations | None (no email, SMS, payments or payroll) |
| Tests | None |

## Features that existed (all kept)

* **Events**: list, register, waitlist/capacity; instructors can create, edit and delete.
* **Training**: courses with video, text and quiz lessons, sequential locking, grading, retakes and attempt snapshots, plus a builder and assignments.
* **Member directory**: opt-out, with admin-controlled visible fields.
* **Notifications**: an in-app notification center.
* **Chat**: forums with categories, threads and posts, plus moderation.
* **Documents**: upload, with role-gated visibility.
* **Members admin**: change role, activate/deactivate, edit, reset password.

## Bugs and security issues found

| # | Issue | Severity | Resolution |
| --- | --- | --- | --- |
| 1 | **Open redirect after login.** `next.startsWith('/')` accepts `//evil.com` and `/\evil.com`. | Medium | Fixed with `safeNext()` in `routes/auth.js`; covered by a test |
| 2 | **No brute-force protection on login** | Medium | Fixed: the account locks for 15 minutes after 5 failures; logged to the audit log |
| 3 | **Errors leak internals.** The 500 handler echoed `err.message` (SQL text) to the browser. | Low/Med | Fixed: a generic message is shown and the error is logged server-side |
| 4 | **Async route errors hang requests.** Express 4 doesn't catch rejected promises, so a thrown DB error left the request hanging until timeout. | Medium | Fixed: patched in `server.js` so rejected promises reach the error handler, the same way Express 5 does |
| 5 | **Hard-coded default `SESSION_SECRET`** when the env var is unset | High if unset | Now warns at boot and is shown on Company Settings. **Action: set `SESSION_SECRET` on Netlify.** |
| 6 | **Public self-registration.** Anyone can register and see the member directory (staff emails and phones). | Medium for a business | Now a setting (`allow_registration`), kept ON so existing behaviour is unchanged. **Recommended: turn it OFF** in Company Settings. |
| 7 | **No audit trail** | – | Added an `audit_log` table, written by every business module |
| 8 | 14-day session lifetime | Low | Reduced to 12 hours (financial data is now in the app) |
| 9 | No security headers | Low | Added nosniff, frame-options, referrer-policy and permissions-policy headers |
| 10 | Mobile `.form-grid` never collapsed (the base rule came after the media query) | Cosmetic | Fixed in CSS |
| 11 | Roles fixed by a CHECK constraint, so no new roles could be added | Blocking | Replaced by configurable `roles` / `permissions` / `role_permissions` tables (migration 001) |

Not changed, but noted:

* CSRF protection relies on `SameSite=Lax` cookies. That blocks cross-site form posts in all modern browsers, but there are no explicit CSRF tokens.
* The `Secure` cookie flag is opt-in (`COOKIE_SECURE=1`), because whether Netlify passes `X-Forwarded-Proto` through to the function still needs confirming. Netlify serves HTTPS only either way.
* `/uploads` static serving still exists for legacy paths. New uploads go to the database.

## Decisions: preserve / improve / add / replace

* **Preserve:** the stack (Express + EJS + Postgres/SQLite + Netlify), the dual-driver DB layer, every training-portal feature, existing URLs and the visual style.
* **Improve:** auth (lockout, redirect safety), roles (configurable RBAC), the navigation (built from permissions and grouped by portal), the error handling, and the CSS.
* **Add:** migrations, audit log, settings, CRM, service requests, jobs and dispatch, inventory and trucks, the time clock, invoices and payments, double-entry accounting and reports, the three portals, the automation log, the messaging outbox and tests.
* **Replace:** only the hard-coded rank checks (`requireRole`). They are now permission checks, with `requireRole` kept as a compatibility wrapper.
