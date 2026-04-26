"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { organisations } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

// Org-level settings actions. Owner-only — manager / host can read
// the page (it's just a toggle list) but can't change anything.
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

  const parsed = ToggleForm.safeParse({
    groupCrmEnabled: formData.get("groupCrmEnabled") || undefined,
  });
  if (!parsed.success) return { status: "error", message: "Couldn't read the form." };
  const enabled = parsed.data.groupCrmEnabled === "on";

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
