// Supabase SSR client for Server Components and Server Actions.
//
// Wraps @supabase/ssr's createServerClient so auth / user lookup happens
// against the caller's cookie session. Lands for real with the auth
// spec (docs/specs/auth.md) — the stub exists so the module path is
// stable and downstream imports can be added in anticipation.

export function supabaseServer(): never {
  throw new Error(
    "lib/db/supabase-server.ts: SSR client not yet wired — lands with the auth spec. " +
      "See docs/specs/auth.md.",
  );
}
