/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SCORING_MODULE_URL?: string;
  readonly VITE_SCORING_PROXY_URL?: string;
  readonly VITE_ONLINE_COMPILER_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
