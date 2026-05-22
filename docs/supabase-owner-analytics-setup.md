## Owner Analytics Setup

The owner analytics tables are private and backend-only.

### 1. Create the tables

Run `docs/supabase-owner-analytics.sql` in the Supabase SQL editor and choose `Run and enable RLS`.

Do not add anon/authenticated policies for these tables.

### 1b. Create the aggregate views

Run `docs/supabase-owner-analytics-views.sql` in the Supabase SQL editor.

These views power the local owner analytics dashboard page.

### 2. Configure the backend secret

The backend can read the analytics config from either environment variables or a local runtime config file.

Environment variables:

- `MACHINE_DARTS_SUPABASE_URL`
- `MACHINE_DARTS_SUPABASE_SERVICE_ROLE_KEY`
- `MACHINE_DARTS_SUPABASE_SECRET_KEY`

Runtime config file:

- Dev run from repo: `backend/data/settings/owner_analytics.json`
- Frozen Windows/Linux build: `<app data>/settings/owner_analytics.json`

Windows frozen path:

- `%APPDATA%/DartDetector/settings/owner_analytics.json`

Linux frozen path:

- `$XDG_DATA_HOME/DartDetector/settings/owner_analytics.json`
- or `~/.local/share/DartDetector/settings/owner_analytics.json`

Example file:

```json
{
  "supabaseUrl": "https://YOUR_PROJECT.supabase.co",
  "secretKey": "YOUR_SUPABASE_SECRET_KEY"
}
```

Environment variables override the file if both are present.

### 3. Restart the backend

After adding the config, restart the backend and check:

- `GET /api/owner-analytics/status`

Expected:

- `enabled: true`
- `baseUrlConfigured: true`
- `serviceRoleConfigured: true`

### 3b. Public installer mode

For public installers, use the Edge Function collector instead of shipping a local secret file.

See:

- `docs/supabase-owner-analytics-edge-function.md`

The public installer path uses:

- Supabase URL
- publishable key
- `owner-analytics-ingest` Edge Function

That means end users do not need to create `owner_analytics.json`.

### 4. Optional local dashboard button

If you want the local workspace dashboard button and route, set this in your local frontend env only:

- `VITE_OWNER_ANALYTICS_UI=1`

Suggested file:

- `frontend/.env.local`

This keeps the button hidden unless you explicitly enable it in your own workspace.
