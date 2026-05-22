/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MACHINE_DARTS_FLAVOR?: string;
  readonly VITE_OWNER_ANALYTICS_UI?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_FRONTON_BUCKET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

