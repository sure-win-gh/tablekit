"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { organisations, venues } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

// Org-level settings actions. Owner-only — manager / host can read
// the page (it's just a toggle list) but can't change anything.
// Group CRM is a Plus-tier feature; the toggle additionally checks
// `requirePlan(orgId, 'plus')` so a Free/Core org cannot enable it
// even if they spoof the form. The settings UI disables the switch
// for non-Plus orgs (defence in depth, but UI alone is not enough).
//
// adminDb because there's no UPDATE policy on organisations for the
// authenticated role; the role check above gates access.

const ToggleForm = z.object({
  groupCrmEnabled: z.string().optional(), // checkbox: "on" or absent
});

export type ToggleGroupCrmState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved"; enabled: boolean };

export async function toggleGroupCrm(
  _prev: ToggleGroupCrmState,
  formData: FormData,
): Promise<ToggleGroupCrmState> {
  const { orgId, userId } = await requireRole("owner");

  try {
    await requirePlan(orgId, "plus");
  } catch (err) {
    if (err instanceof InsufficientPlanError) {
      return {
        status: "error",
        message: "Group CRM is a Plus-tier feature. Upgrade to enable it.",
      };
    }
    throw err;
  }

  const parsed = ToggleForm.safeParse({
    groupCrmEnabled: formData.get("groupCrmEnabled") || undefined,
  });
  if (!parsed.success) return { status: "error", message: "Couldn't read the form." };
  const enabled = parsed.data.groupCrmEnabled === "on";

  // Group CRM is the cross-venue aggregate view; meaningless with one
  // venue. The settings UI disables the switch in that state, but the
  // server is the source of truth — reject a spoofed enable so the
  // org row never holds an enabled flag that the UI also can't render.
  if (enabled) {
    const [{ count } = { count: 0 }] = await adminDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(venues)
      .where(eq(venues.organisationId, orgId));
    if (count < 2) {
      return {
        status: "error",
        message: "Add a second venue before enabling cross-venue CRM.",
      };
    }
  }

  await adminDb()
    .update(organisations)
    .set({ groupCrmEnabled: enabled })
    .where(eq(organisations.id, orgId));

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: enabled ? "org.group_crm.enabled" : "org.group_crm.disabled",
    targetType: "organisation",
    targetId: orgId,
  });

  revalidatePath("/dashboard/organisation");
  revalidatePath("/dashboard/guests");
  return { status: "saved", enabled };
}
