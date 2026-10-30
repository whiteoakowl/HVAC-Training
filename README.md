# HVAC Training Portal

A member portal for an HVAC training program: Events, Training (with quizzes
and progress tracking), a Member Directory, a Notification Center, Chat
(forums), and Documents. Built with Node/Express/EJS on Postgres (Supabase) or SQLite
(local dev, no setup needed).

Adapted from a reference "Coop Admin Portal" bundle's 6 member-facing
features, simplified to a single-role-per-account model (`student`,
`instructor`, `admin`) rather than a multi-portal/roles-and-permissions
system, since this app only ever needs one member-facing portal.

## Setup

```
npm install
npm run seed   # creates the schema + demo accounts/data
npm start      # http://localhost:3000
```

Demo logins (password `password123` for all):
- `admin@hvactraining.test` - admin
- `instructor@hvactraining.test` - instructor
- `student@hvactraining.test` - student

## Features

| Tab | Route | Notes |
| --- | --- | --- |
| Events | `/events` | List/register; instructors+ can create/edit/delete (`/events/manage`) |
| Training | `/training/mine` | Video/text/quiz lessons, sequential locking, quiz grading, retakes; builder at `/training/manage` |
| Member Directory | `/member-directory` | Opt-in browse; admin controls which fields show (`/member-directory/settings`) |
| Communication | `/notifications` | In-app notification center, fed by events/training/forums/documents |
| Chat | `/forums` | Categories -> threads -> posts; instructor/admin moderation (pin/lock/archive/remove) |
| Documents | `/documents` | New feature (no equivalent in the reference bundle) - instructors+ upload, role-gated visibility |

Role management lives at `/portal/members` (admin only).

## Data

Two database options, same code:

- **Postgres / Supabase** - used whenever `DATABASE_URL` holds a
  `postgres://` connection string. Tables are created automatically on
  startup.
- **SQLite** - the fallback for local development, at
  `data/hvac_training.sqlite` (gitignored).

Uploaded documents are stored in the database (`document_files` table),
not on disk, so they persist on serverless hosts.

## Deploying to Netlify + Supabase

`netlify.toml` runs the Express app as a single Netlify Function
(`netlify/functions/app.js`, via `serverless-http`); `public/` is served
from the CDN and every other path is rewritten to the function. No build
settings need to be entered in the Netlify UI.

1. In Supabase: **Connect** (top of the project dashboard) -> copy the
   **Transaction pooler** connection string (port `6543`) and put your
   database password into it.
2. In Netlify: **Site configuration -> Environment variables**, add:
   - `DATABASE_URL` - the connection string from step 1
   - `SESSION_SECRET` - any long random string (signs login cookies)
   - `SEED_PASSWORD` - password for the demo accounts (otherwise it's the
     public default `password123`)
3. Redeploy (Deploys -> Trigger deploy). The first request creates the
   tables and the demo accounts/data.

Without `DATABASE_URL`, a Netlify deploy still runs but falls back to
SQLite in `/tmp`, which **resets on every cold start**.

Netlify Functions cap request bodies at ~6 MB, so larger document uploads
fail there.
