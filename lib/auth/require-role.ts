// Role-gated auth context for server actions / route handlers / RSC.
//
// requireRole(min) resolves the current session, the active-org cookie,
// and the caller's membership row in that org — then redirects (for
// missing session / missing org / missing membership) or throws
// (for insufficient role). Returns { userId, orgId, role } so the
// caller doesn't need to look anything up again.
//
// Usage (server action):
//   const { orgId } = await requireRole("manager");
//   // ... do privileged work scoped to orgId ...
//
// Redirects vs throws: missing session is a recoverable UX path
// (login again), so we redirect. Insufficient role is an app-logic
// bug or a security probe, so we throw — should surface in Sentry.

import "server-only";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { withUser } from "@/lib/db/client";
import { memberships } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";

import { getActiveOrg } from "./active-org";
import { hasRole, type OrgRole } from "./role-level";

export type AuthContext = {
  userId: string;
  orgId: string;
  role: OrgRole;
};

export async function requireRole(min: OrgRole): Promise<AuthContext> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const orgId = await getActiveOrg();
  if (!orgId) redirect("/login?error=no_active_org");

  const found = await withUser(async (db) => {
    const rows = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.organisationId, orgId)))
      .limit(1);
    return rows[0];
  });

  if (!found) redirect("/login?error=no_membership");

  if (!hasRole(found.role, min)) {
    throw new Error(`requireRole: need '${min}', have '${found.role}'`);
  }

  return { userId: user.id, orgId, role: found.role };
}
