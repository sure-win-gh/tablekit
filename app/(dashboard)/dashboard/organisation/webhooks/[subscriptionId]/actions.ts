"use server";

// Replay action for the delivery log page.
//
// Same auth gates as the create/revoke actions: requireRole("owner")
// + requirePlan(orgId, "plus"). A replay enqueues a fresh delivery
// to a real subscriber URL — owner-only is the right floor.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/server/admin/audit";
import { replayDelivery } from "@/lib/webhooks/replay";

const Input = z.object({
  deliveryId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
});

export type ReplayResult = { ok: true } | { ok: false; error: string };

export async function replayDeliveryAction(input: z.infer<typeof Input>): Promise<ReplayResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const { orgId, userId } = await requireRole("owner");
  await requirePlan(orgId, "plus");

  const r = await replayDelivery({
    deliveryId: parsed.data.deliveryId,
    organisationId: orgId,
  });
  if (!r.ok) {
    return {
      ok: false,
      error:
        r.reason === "not-found"
          ? "Delivery not found."
          : "Subscription is paused or revoked — un-pause before replaying.",
    };
  }

  await audit.log({
    organisationId: orgId,
    action: "webhook_subscription.delivery_replayed",
    actorUserId: userId,
    targetType: "webhook_subscription",
    targetId: parsed.data.subscriptionId,
    metadata: {
      original_delivery_id: parsed.data.deliveryId,
      replay_delivery_id: r.replayDeliveryId,
    },
  });

  revalidatePath(`/dashboard/organisation/webhooks/${parsed.data.subscriptionId}`);
  return { ok: true };
}
