// Hard auth gate for the /admin (Tablekit-staff) dashboard.
//
// requirePlatformAdmin() resolves the Supabase session and checks the
// caller's email against process.env.ADMIN_EMAILS (comma-separated).
//   - missing session  -> redirect /login (recoverable UX path)
//   - non-allowlisted  -> throw (security probe; surfaces in Sentry)
//
// Defense in depth: proxy.ts also blocks /admin/* at the edge for
// non-allowlisted users. Both layers must be in place — losing one
// mustn't open the door.
//
// We re-parse ADMIN_EMAILS on every call rather than capturing at
// module init so a hot-reload / redeploy picks up changes immediately.
// The env var is comma- or whitespace-separated; entries are trimmed
// and lowercased before comparison.

import "server-only";

import { redirect } from "next/navigation";

import { supabaseServer } from "@/lib/db/supabase-server";

import { isPlatformAdminEmail } from "./allowlist";

export type PlatformAdminSession = {
  userId: string;
  email: string;
};

export async function requirePlatformAdmin(): Promise<PlatformAdminSession> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?from=admin");

  const email = user.email ?? null;
  if (!isPlatformAdminEmail(email)) {
    throw new Error("requirePlatformAdmin: caller is not on ADMIN_EMAILS allowlist");
  }

  return { userId: user.id, email: email as string };
}
