"use server";

// Server actions for webhook subscription management.
//
// Same auth gates as the api-keys actions: requireRole("owner") +
// requirePlan(orgId, "plus"). Outbound webhook secrets carry no
// platform-side authority but a malicious subscription could
// exfiltrate booking events to an attacker, so we lock the create
// path to owners only.
//
// Plaintext secret is returned exactly once from createSubscription
// — the action passes it to the client form's reveal panel and then
// nothing in this action layer holds it.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/server/admin/audit";
import {
  WEBHOOK_EVENTS,
  type WebhookEvent,
  createSubscription,
  revokeSubscription,
} from "@/lib/webhooks/subscribe";

const CreateInput = z.object({
  // HTTPS-only. Storage CHECK enforces the same; this is the
  // friendly version with a clear error message.
  url: z
    .string()
    .url("Must be a valid URL.")
    .refine((u) => u.startsWith("https://"), "URL must use https://")
    .max(2048, "URL too long"),
  label: z.string().trim().min(1, "Label required").max(80, "Label too long"),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Select at least one event"),
});

const RevokeInput = z.object({ subscriptionId: z.string().uuid() });

export type CreateResult =
  | { ok: true; id: string; plaintextSecret: string }
  | { ok: false; error: string };
export type RevokeResult = { ok: true } | { ok: false; error: string };

export async function createSubscriptionAction(
  input: z.infer<typeof CreateInput>,
): Promise<CreateResult> {
  const parsed = CreateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  const { orgId, userId } = await requireRole("owner");
  await requirePlan(orgId, "plus");

  const created = await createSubscription({
    organisationId: orgId,
    createdByUserId: userId,
    url: parsed.data.url,
    label: parsed.data.label,
    events: parsed.data.events as ReadonlyArray<WebhookEvent>,
  });

  // Audit metadata: url + label + events. NO plaintext secret. The
  // url is operator-supplied but reachable via the dashboard list,
  // so it's already operator-visible; logging it here gives an
  // ops-investigable trail of who registered which endpoint.
  await audit.log({
    organisationId: orgId,
    action: "webhook_subscription.created",
    actorUserId: userId,
    targetType: "webhook_subscription",
    targetId: created.id,
    metadata: { url: parsed.data.url, label: parsed.data.label, events: parsed.data.events },
  });

  revalidatePath("/dashboard/organisation/webhooks");
  return { ok: true, id: created.id, plaintextSecret: created.plaintextSecret };
}

export async function revokeSubscriptionAction(
  input: z.infer<typeof RevokeInput>,
): Promise<RevokeResult> {
  const parsed = RevokeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const { orgId, userId } = await requireRole("owner");
  await requirePlan(orgId, "plus");

  const r = await revokeSubscription({
    subscriptionId: parsed.data.subscriptionId,
    organisationId: orgId,
  });
  if (!r.revoked) {
    revalidatePath("/dashboard/organisation/webhooks");
    return { ok: true }; // already revoked or wrong-org → caller's intent met
  }

  await audit.log({
    organisationId: orgId,
    action: "webhook_subscription.revoked",
    actorUserId: userId,
    targetType: "webhook_subscription",
    targetId: parsed.data.subscriptionId,
  });

  revalidatePath("/dashboard/organisation/webhooks");
  return { ok: true };
}
