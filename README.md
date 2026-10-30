# HVAC Training Portal

A member portal for an HVAC training program: Events, Training (with quizzes
and progress tracking), a Member Directory, a Notification Center, Chat
(forums), and Documents. Built with Node/Express/EJS and SQLite
(better-sqlite3) - no external database required.

Adapted from a reference "Coop Admin Portal" bundle's 6 member-facing
features, simplified to a single-role-per-account model (`student`,
`instructor`, `admin`) rather than a multi-portal/roles-and-permissions
system, since this app only ever needs one member-facing portal.

## Setup

```
npm install
npm run seed   # creates the SQLite schema + demo accounts/data
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

SQLite database lives at `data/hvac_training.sqlite` (gitignored, created on
first run/seed). Uploaded documents go to `uploads/documents/`.

## Deploying to Netlify

`netlify.toml` runs the Express app as a single Netlify Function
(`netlify/functions/app.js`, via `serverless-http`); `public/` is served
from the CDN and every other path is rewritten to the function. No build
settings need to be entered in the Netlify UI.

Set a `SESSION_SECRET` environment variable in Netlify (Site configuration
-> Environment variables) - sessions are signed cookies.

**Limitations - Netlify is a demo host for this app, not a production one:**
- Functions have no persistent disk, so the SQLite DB and uploads live in
  `/tmp` and are **reset on every cold start** (each fresh instance is
  re-seeded with the demo accounts). Registrations, quiz progress, posts
  and uploaded documents will disappear, and can differ between instances.
- Request bodies are capped at ~6 MB, so larger document uploads fail.

For real use, either host it on a platform with a persistent disk
(Render, Railway, Fly.io - `npm start` works as-is) or move the data to a
hosted database (e.g. Netlify DB/Postgres, Turso) and files to object
storage (e.g. Netlify Blobs).
