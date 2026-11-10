# Development roadmap

The work is ordered by dependency: the foundation first, then the money flow (job → inventory → invoice → ledger), then the modules that build on it.

## Stage 1 – foundation and core operations (done)

* Migrations, configurable roles and permissions, settings, audit log.
* The three portals, with navigation built from each user's permissions.
* CRM.
* Service requests and the Wix API.
* Jobs and dispatch.
* Inventory and trucks.
* Time clock.
* Invoices and payments.
* Double-entry ledger and financial statements.
* Job costing.
* Management dashboard.
* Automations and the messaging outbox.

## Stage 2 – done

| Module | Status |
| --- | --- |
| **Estimates / proposals** | **Done.** Line items from the catalog or free text, discount, tax, deposit, payment schedule, terms, warranty and expiry. Printable PDF layout. Sent by email or text with a no-login approval link where the customer signs. Revisions, office-recorded approvals, approval → job (automation), deposit invoice. Close-rate statistics. |
| **Change orders** | **Done.** Added on the job, signed by the customer on the tech's phone, added to the final invoice automatically. |
| **Purchasing** | **Done.** Vendors, supply lists / purchase orders, approval by a second person, ordered, receiving (partial deliveries and backorders), restock purchase orders drafted from low stock (preferred vendor per item). |
| **Accounts payable** | **Done.** Vendor bills: matched to purchase-order receipts, or entered directly with any expense account; attachment; payments by check, ACH or company card; void; A/P aging. Accounting: goods-received-not-invoiced (2050) → A/P (2000). |
| **Expenses** | **Done.** Categorized expenses with receipt photo, paid from checking, the company card or the owner; tied to a job, truck or employee; voids reverse the entry; CSV export. Recurring expenses remind but never post themselves. |
| **Credits & refunds** | **Done.** Credit memos (4910) and refunds; status is recalculated from payments, credits and the total. Invoices with payments now have a path: refund, then void, or issue a credit. |
| **Maintenance agreements** | **Done.** Plans; agreements with a term, covered equipment and visits spread evenly across it. Visit jobs are created automatically as they come due; completing the job completes the visit. Covered visits aren't billed again; parts are. Agreement invoices go to 4200. Auto-renew creates the renewal and a draft invoice; expiry and renewal reminders. |
| **Payroll records** | **Done.** Runs built from approved time (weekly overtime at 1.5×), approved paid leave and salary. Bonuses, commissions and reimbursements; withholdings and deductions entered from the provider's register. Two-person approval, posting to the ledger, pay stubs with year-to-date totals visible only to the employee, CSV export. |
| **Time off** | **Done.** Vacation, sick, personal and unpaid requests; overlap checks; approval (not by the requester) draws down PTO and sick balances; cancelling restores them. |
| **Communication** | **Done.** Company announcements (all staff or one role; pinned; expiry) with notifications. Employee direct messages. Customer email and text from the customer page, logged in the communication history. |
| **End-of-day reports** | **Done.** The technician submits work done, issues, materials needed and mileage; managers review by date; reported issues notify managers. |
| **Checklists & inspection forms** | **Done.** Templates managed in Admin (AC tune-up, furnace safety and install completion are seeded). The technician records pass, fail or n/a with readings on the job. |
| **Tools & equipment** | **Done.** Assets assigned to employees or trucks, with status and calibration/service due date. |
| **Documents** | **Done.** Files attached to customers, jobs, employees, equipment (photos, manuals, warranty papers) and vendors, with access following each record's permissions. Searchable shared library. |
| **Training center** | **Done.** Course categories, renewal periods, required courses by role (assigned automatically), company-wide completion matrix, expiry and overdue reminders. |
| **Customer portal** | **Done.** Customer logins created from the customer page. The customer sees their own appointments, service history, equipment, invoices, estimates and plan, and can request service. |
| **Security** | **Done.** Two-step verification (authenticator app) with an admin reset; password reset by email; forced change of temporary passwords. |
| **Scheduled automations** | **Done.** A Netlify scheduled function runs daily: estimate follow-ups and expiry, maintenance visit jobs and renewals, overdue-invoice alerts, optional customer payment reminders, certification and tool-service alerts, training assignment and renewal, recurring-expense reminders. It can also be run from Admin. |
| **Timezone** | **Done.** Company timezone setting; times are stored and shown in local time. |
| **Reports** | **Added:** estimate close rate, repeat-customer rate and maintenance-agreement revenue. |

## Stage 3 – next (needs a decision or credentials from you)

| Item | Needed from you |
| --- | --- |
| Online card payments on invoices (customer portal / invoice link) | A Stripe account (or other processor) and its API keys |
| Payroll provider integration (Gusto / ADP / QuickBooks Payroll): push hours, pull the register automatically | Which provider, plus API access |
| Accounting export to QuickBooks / Xero | Which product; OAuth app credentials |
| Route optimisation / maps on the dispatch board | A Google Maps (or Mapbox) API key |
| QR codes for authenticator setup | Optional: a small QR library (today the setup key is typed in or opened via a link) |
| Daily overtime rules (e.g. California) and state-specific leave accrual | Which states you operate in |
| Recurring billing for monthly maintenance plans | A payment processor (see the first row) |
