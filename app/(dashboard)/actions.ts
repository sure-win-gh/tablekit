"use server";

import { eq, and } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";

import { clearActiveOrg, setActiveOrg } from "@/lib/auth/active-org";
import { withUser } from "@/lib/db/client";
import { memberships } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";

export async function signOut(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  await clearActiveOrg();
  redirect("/login");
}

const SwitchInput = z.object({ orgId: z.string().uuid() });

// Server action: switch the active organisation for a multi-membership
// user. Verifies the user actually belongs to the target org via
// withUser (RLS scopes the SELECT to memberships in orgs the JWT
// subject is in), so a forged orgId in the form payload can't elevate.
// On success, set the cookie + redirect to /dashboard so layouts
// reload against the new scope.
export async function switchActiveOrgAction(input: { orgId: string }): Promise<void> {
  const parsed = SwitchInput.safeParse(input);
  if (!parsed.success) redirect("/dashboard");

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const allowed = await withUser(async (db) => {
    const [row] = await db
      .select({ id: memberships.organisationId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.organisationId, parsed.data.orgId),
        ),
      )
      .limit(1);
    return Boolean(row);
  });

  if (!allowed) {
    // Either the orgId is bogus or the user isn't a member. Don't
    // distinguish — silently bounce.
    redirect("/dashboard");
  }

  await setActiveOrg(parsed.data.orgId);
  redirect("/dashboard");
}
