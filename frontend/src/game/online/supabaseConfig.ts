export const SUPABASE_URL =
  String(import.meta.env.VITE_SUPABASE_URL || "").trim() ||
  "https://vchcxcijkmicdrtcggrj.supabase.co";

export const SUPABASE_ANON_KEY =
  String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim() ||
  "sb_publishable_ulUjBZUytB60vEpEM0UYNA_8PLqWeWf";

export const SUPABASE_FRONTON_BUCKET =
  String(import.meta.env.VITE_SUPABASE_FRONTON_BUCKET || "").trim() || "online-fronton";
