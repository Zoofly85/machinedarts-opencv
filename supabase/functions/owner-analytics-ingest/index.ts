import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-machine-darts-analytics",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const allowedTables = new Set(["owner_app_events", "owner_match_summaries"]);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "Function is not configured" }, { status: 500, headers: corsHeaders });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Body must be an object" }, { status: 400, headers: corsHeaders });
  }

  const table = typeof (body as { table?: unknown }).table === "string" ? String((body as { table: string }).table) : "";
  const payload = (body as { payload?: unknown }).payload;

  if (!allowedTables.has(table)) {
    return Response.json({ error: "Unsupported analytics table" }, { status: 400, headers: corsHeaders });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Payload must be an object" }, { status: 400, headers: corsHeaders });
  }

  const { error } = await admin.from(table).insert(payload as Record<string, unknown>);
  if (error) {
    return Response.json(
      { error: "Insert failed", details: error.message, code: error.code },
      { status: 500, headers: corsHeaders },
    );
  }

  return Response.json({ status: "ok", table }, { headers: corsHeaders });
});
