## Owner Analytics Edge Function

For public installers, do not ship a local Supabase secret file.

Instead, deploy the Supabase Edge Function in:

- `supabase/functions/owner-analytics-ingest`

The installed app/backend can then send analytics with the public Supabase URL and publishable key. The function uses the server-side service role key inside Supabase to insert rows into:

- `owner_app_events`
- `owner_match_summaries`

### Deploy

From the repo root:

```bash
supabase functions deploy owner-analytics-ingest --no-verify-jwt
```

### Why `--no-verify-jwt`

This analytics ingestion endpoint is intended for app-level anonymous telemetry. The local bundled backend sends events with the public key, not a signed user session token.

### Required Supabase setup

Run these first:

- `docs/supabase-owner-analytics.sql`
- `docs/supabase-owner-analytics-views.sql`

### Runtime behavior

- Workspace/private machine:
  If `owner_analytics.json` contains a secret key, the backend uses direct table writes and can also power the local dashboard page.

- Public installer:
  If no secret is present, the backend falls back to the Edge Function using the public key.

### Notes

- The local owner dashboard still requires a local secret/service-role config for aggregate view queries.
- Public users do not need to create `owner_analytics.json`.
