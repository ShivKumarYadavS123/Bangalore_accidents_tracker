# Bangalore Accidents Tracker: Supabase Handoff

## Current state

- Supabase Auth is used by the frontend for registration, login, sessions, and role checks.
- The browser uses only the Supabase anon key from `Frontend/js/bat-config.js`.
- The API and seed scripts use PostgreSQL. Set `SUPABASE_DATABASE_URL` to the Supabase transaction pooler URL so hosted Supabase is the source of truth.
- `Database/schema.sql` contains the accidents, hospitals, emergency alerts, PostGIS functions, indexes, and moderation helpers.
- The configured project currently has accident records and `get_accidents_fc`; run the schema before using hospital and alert features.

## One-time Supabase setup

1. In Supabase Dashboard, open **SQL Editor** and run `Database/schema.sql`. Re-run it after every pull — it's idempotent (`CREATE OR REPLACE FUNCTION`, `ADD COLUMN IF NOT EXISTS`) and picks up new RPCs such as `set_accident_geom`, used by `POST /api/reports` to save a user-submitted pin's coordinates.
2. In **Project Settings > Database > Connect**, copy the **Transaction pooler** URI.
3. Copy `server/.env.example` to `server/.env` and fill in the database password, project API values, and a private `ADMIN_SLUG`.
4. Create an admin user in **Authentication > Users**. There is no default admin username or password in this repository.
5. Set that user's `app_metadata.role` to `admin` using a trusted server-side Supabase Admin API script. Never put a service-role key in the frontend.

## Migrations for an existing project

`Database/schema.sql` always describes the latest state. For a project that is already set up, also run each file in `Database/migrations/` once, in order, in the SQL Editor:

- `001_security_batch_1.sql`: tightens row-level security (no direct inserts into `accidents`, no direct hospital access to `emergency_alerts`, reporters can't change the status or action note of civic issues) and limits the browser's anon key to public columns. It runs in one transaction and rolls itself back if a private column is still readable afterwards. A commented rollback is at the bottom of the file.

## Server environment notes

- `SUPABASE_SERVICE_ROLE_KEY` is required whenever `SUPABASE_URL` or `SUPABASE_ANON_KEY` is set in `server/.env`. The API refuses to start without it rather than falling back to the anon key. With no Supabase settings at all it runs in offline/dev mode.
- `TRUST_PROXY` (default: off) tells the API how many reverse proxies sit in front of it. Set it when the API is behind a proxy or load balancer (Render, Railway, Fly.io, Nginx, Cloudflare…). Without it every request appears to come from the proxy, so all users share one rate limit. Use the number of proxies, usually `TRUST_PROXY=1`, or a comma-separated list of trusted addresses/subnets such as `TRUST_PROXY=loopback, 10.0.0.0/8`. Leave it unset when clients reach the API directly, and avoid `TRUST_PROXY=true`. In both of those cases clients could fake `X-Forwarded-For` to dodge rate limits.

## Load and run

From `server/`:

```powershell
npm install
npm run seed
npm run seed:hospitals
npm start
```

The seed is idempotent for existing accident IDs and hospital IDs. The API then reads and writes the Supabase database, including user reports, moderation changes, emergency alerts, and analytics.

## Handoff checklist

- Keep `server/.env` out of source control and rotate any key that has been shared publicly.
- Give the next maintainer the Supabase project URL, repository, schema file, and deployment environment variables through a password manager.
- Keep the Supabase anon key in the frontend only; keep the service-role key and database URI on the server only.
- Configure Supabase Auth email confirmation and redirect URLs for the deployed frontend.