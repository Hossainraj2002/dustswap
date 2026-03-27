import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY;

export function getSupabaseDiagnostics() {
  const loadedEnv = process.env.SUPABASE_SERVICE_ROLE_KEY
    ? "SUPABASE_SERVICE_ROLE_KEY"
    : process.env.SUPABASE_SECRET_KEY
      ? "SUPABASE_SECRET_KEY"
      : process.env.SUPABASE_ANON_KEY
        ? "SUPABASE_ANON_KEY"
        : process.env.SUPABASE_PUBLISHABLE_KEY
          ? "SUPABASE_PUBLISHABLE_KEY"
          : "missing";

  let urlRef = "missing";
  try {
    urlRef = supabaseUrl ? new URL(supabaseUrl).hostname.split(".")[0] : "missing";
  } catch {
    urlRef = "invalid-url";
  }

  const keyType = !supabaseKey
    ? "missing"
    : supabaseKey.startsWith("sb_secret_")
      ? "secret"
      : supabaseKey.startsWith("sb_publishable_")
        ? "publishable"
        : supabaseKey.startsWith("eyJ")
          ? "legacy-jwt"
          : "unknown";

  return {
    loadedEnv,
    urlRef,
    keyType,
  };
}

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "SUPABASE_URL and a Supabase server/public key are required"
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
