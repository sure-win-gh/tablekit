"use server";

// Server actions for the API keys management page.
//
// Both actions enforce the same gates:
//   1. requireRole("owner")          — issuing API access is sensitive;
//                                       hosts and managers cannot.
//   2. requirePlan(orgId, "plus")    — Plus tier only per spec.
//   3. Audit log on every mutation.
//
// `issueKeyAction` returns the plaintext to the caller exactly once.
// The client form holds it in component state and renders it in a
// copy-once panel; once the operator dismisses, it's gone forever
// (we never persist plaintext, only the SHA-256 hash).

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { issueApiKey, revokeApiKey } from "@/lib/api-keys/issue";
import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/server/admin/audit";

const IssueInput = z.object({
  // Operator-given label. Matches the DB CHECK (1–80 chars). The Zod
  // bound is the friendly version; the CHECK is the backstop.
  label: z.string().trim().min(1, "label required").max(80, "label too long (80 chars max)"),
});

const RevokeInput = z.object({
  keyId: z.string().uuid(),
});

export type IssueResult =
  | { ok: true; plaintext: string; prefix: string; id: string }
  | { ok: false; error: string };

export type RevokeResult = { ok: true } | { ok: false; error: string };

export async function issueKeyAction(input: z.infer<typeof IssueInput>): Promise<IssueResult> {
  const parsed = IssueInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  const { orgId, userId } = await requireRole("owner");
  await requirePlan(orgId, "plus");

  const issued = await issueApiKey({
    organisationId: orgId,
    label: parsed.data.label,
    createdByUserId: userId,
  });

  // Audit AFTER issue lands. Metadata is correlation handles only —
  // never the plaintext or the hash. The prefix is operator-visible
  // and safe to log (it's the same thing we show in the dashboard
  // list to identify the key).
  await audit.log({
    organisationId: orgId,
    action: "api_key.issued",
    actorUserId: userId,
    targetType: "api_key",
    targetId: issued.id,
    metadata: { prefix: issued.prefix, label: parsed.data.label },
  });

  revalidatePath("/dashboard/organisation/api-keys");
  return { ok: true, plaintext: issued.plaintext, prefix: issued.prefix, id: issued.id };
}

export async function revokeKeyAction(input: z.infer<typeof RevokeInput>): Promise<RevokeResult> {
  const parsed = RevokeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const { orgId, userId } = await requireRole("owner");
  await requirePlan(orgId, "plus");

  const r = await revokeApiKey({ keyId: parsed.data.keyId, organisationId: orgId });
  if (!r.revoked) {
    // Already revoked or doesn't belong to this org. Either way the
    // caller's intent ("make sure this key cannot authenticate") is
    // satisfied — return ok.
    revalidatePath("/dashboard/organisation/api-keys");
    return { ok: true };
  }

  await audit.log({
    organisationId: orgId,
    action: "api_key.revoked",
    actorUserId: userId,
    targetType: "api_key",
    targetId: parsed.data.keyId,
  });

  revalidatePath("/dashboard/organisation/api-keys");
  return { ok: true };
}
