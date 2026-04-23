// RLS-respecting Drizzle client.
//
// The auth spec will wire this to forward the caller's Supabase session
// JWT so Postgres evaluates row-level policies against auth.uid() /
// auth.jwt(). Until then, calling db() throws so no domain code can
// accidentally query the database without the RLS plumbing in place.
//
// For service_role access that bypasses RLS, see lib/server/admin/db.ts
// — use that ONLY from lib/server/admin/*.

export function db(): never {
  throw new Error(
    "lib/db/client.ts: authed Drizzle client not yet wired — lands with the auth spec. " +
      "See docs/specs/auth.md.",
  );
}
