"use server";

// Operator actions for the enquiry inbox.
//
// Each action runs the standard auth pipeline:
//   1. requireRole("host")           — authed dashboard user
//   2. requirePlan(orgId, "plus")    — Plus tier only (gates the
//      whole feature, including read paths)
//   3. assertVenueVisible(venueId)   — per-venue scope; a manager
//      with `venueIds = [v1]` cannot operate against v2
//   4. row check: enquiry belongs to the asserted venue. Belt-and-
//      braces against a forged `enquiryId` from a different venue
//      in the same org.
//
// Pure decision logic lives in lib/enquiries/operator-actions.ts —
// keeps status transitions unit-testable. Writes go through
// adminDb() because RLS allows operator UPDATE only for status
// transitions we explicitly want; the conditional WHERE on status
// guards against double-action.

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { requirePlan } from "@/lib/auth/require-plan";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { enquiries, venues } from "@/lib/db/schema";
import { sendEnquiryReply } from "@/lib/enquiries/send-reply";
import {
  applyDismiss,
  applyResetOrphan,
  applyRetryFailed,
  applySendDraftPostSend,
  decideSendDraft,
  type ApplyResult,
} from "@/lib/enquiries/operator-actions";
import { type Ciphertext, decryptPii, encryptPii, type Plaintext } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

// Shared inbound subdomain constant. The catch-all MX on this
// subdomain routes <slug>@... back into our resend-inbound webhook,
// so guests' replies become new enquiries on the same venue. Must
// match `INBOUND_DOMAIN` in app/api/webhooks/resend-inbound/route.ts.
const INBOUND_DOMAIN = "enquiries.tablekit.uk";

const SendDraftInput = z.object({
  venueId: z.string().uuid(),
  enquiryId: z.string().uuid(),
  // Operator-edited body. Empty string is rejected — we never want to
  // ship a blank reply.
  body: z.string().min(1).max(10_000),
  subject: z.string().min(1).max(200),
});

const VenueEnquiryInput = z.object({
  venueId: z.string().uuid(),
  enquiryId: z.string().uuid(),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function sendDraftAction(
  input: z.infer<typeof SendDraftInput>,
): Promise<ActionResult> {
  const parsed = SendDraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const { orgId, userId } = await requireRole("host");
  await requirePlan(orgId, "plus");
  if (!(await assertVenueVisible(parsed.data.venueId))) {
    return { ok: false, error: "venue not visible" };
  }

  const db = adminDb();
  const [row] = await db
    .select({
      id: enquiries.id,
      organisationId: enquiries.organisationId,
      venueId: enquiries.venueId,
      status: enquiries.status,
      fromEmailCipher: enquiries.fromEmailCipher,
      draftReplyCipher: enquiries.draftReplyCipher,
      venueSlug: venues.slug,
    })
    .from(enquiries)
    .innerJoin(venues, eq(venues.id, enquiries.venueId))
    .where(and(eq(enquiries.id, parsed.data.enquiryId), eq(enquiries.venueId, parsed.data.venueId)))
    .limit(1);
  if (!row) return { ok: false, error: "enquiry not found" };

  const decision = decideSendDraft({
    status: row.status as Parameters<typeof decideSendDraft>[0]["status"],
    hasDraft: row.draftReplyCipher !== null,
    now: new Date(),
  });
  if (!decision.ok) return { ok: false, error: rejectionMessage(decision.rejection) };

  // Reply-to: <slug>@enquiries.tablekit.uk so a guest reply lands
  // back as a new inbound enquiry on the same venue. A slugless
  // venue can't receive enquiries via the inbound webhook in the
  // first place, so this branch is unreachable in practice — but
  // keep the guard so a future bug doesn't ship the guest's own
  // address as Reply-To (which would create a self-reply loop).
  if (!row.venueSlug) {
    return { ok: false, error: "venue has no slug; reply target unavailable" };
  }
  const replyTo = `${row.venueSlug}@${INBOUND_DOMAIN}`;

  const guestEmail = await decryptPii(row.organisationId, row.fromEmailCipher as Ciphertext);

  // Re-encrypt the (possibly edited) body so the persisted record
  // reflects what actually went out, not the original draft.
  const finalBodyCipher = await encryptPii(row.organisationId, parsed.data.body as Plaintext);

  let providerId: string;
  try {
    const r = await sendEnquiryReply({
      to: guestEmail,
      replyTo,
      subject: parsed.data.subject,
      body: parsed.data.body,
      idempotencyKey: `enquiry-reply:${row.id}`,
    });
    providerId = r.providerId;
  } catch {
    // The SDK error is already sanitised inside sendEnquiryReply
    // (no recipient address, no body content). We surface a generic
    // message to the operator UI so the action result string is
    // stable + PII-free across retries.
    return { ok: false, error: "Reply could not be sent. Please try again shortly." };
  }

  await applySendDraftPostSend(db, {
    enquiryId: row.id,
    venueId: parsed.data.venueId,
    finalBodyCipher,
    repliedAt: decision.next.repliedAt,
  });

  // Audit AFTER the persist so a writer crash mid-flight doesn't
  // claim a reply landed when it didn't. Metadata is correlation
  // handles only — never the body or guest email.
  await audit.log({
    organisationId: row.organisationId,
    action: "enquiry.replied",
    actorUserId: userId,
    targetType: "enquiry",
    targetId: row.id,
    metadata: { venueId: parsed.data.venueId, providerId },
  });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries`);
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries/${parsed.data.enquiryId}`);
  return { ok: true };
}

export async function dismissEnquiryAction(
  input: z.infer<typeof VenueEnquiryInput>,
): Promise<ActionResult> {
  const parsed = VenueEnquiryInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const { orgId, userId } = await requireRole("host");
  await requirePlan(orgId, "plus");
  if (!(await assertVenueVisible(parsed.data.venueId))) {
    return { ok: false, error: "venue not visible" };
  }

  const r = await applyDismiss(adminDb(), {
    enquiryId: parsed.data.enquiryId,
    venueId: parsed.data.venueId,
  });
  if (!r.ok) return { ok: false, error: applyResultMessage(r) };

  await audit.log({
    organisationId: orgId,
    action: "enquiry.dismissed",
    actorUserId: userId,
    targetType: "enquiry",
    targetId: parsed.data.enquiryId,
    metadata: { venueId: parsed.data.venueId },
  });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries`);
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries/${parsed.data.enquiryId}`);
  return { ok: true };
}

export async function resetOrphanAction(
  input: z.infer<typeof VenueEnquiryInput>,
): Promise<ActionResult> {
  const parsed = VenueEnquiryInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const { orgId, userId } = await requireRole("host");
  await requirePlan(orgId, "plus");
  if (!(await assertVenueVisible(parsed.data.venueId))) {
    return { ok: false, error: "venue not visible" };
  }

  const r = await applyResetOrphan(adminDb(), {
    enquiryId: parsed.data.enquiryId,
    venueId: parsed.data.venueId,
    now: new Date(),
  });
  if (!r.ok) return { ok: false, error: applyResultMessage(r) };

  await audit.log({
    organisationId: orgId,
    action: "enquiry.reset",
    actorUserId: userId,
    targetType: "enquiry",
    targetId: parsed.data.enquiryId,
    metadata: { venueId: parsed.data.venueId },
  });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries`);
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries/${parsed.data.enquiryId}`);
  return { ok: true };
}

export async function retryFailedAction(
  input: z.infer<typeof VenueEnquiryInput>,
): Promise<ActionResult> {
  const parsed = VenueEnquiryInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const { orgId, userId } = await requireRole("host");
  await requirePlan(orgId, "plus");
  if (!(await assertVenueVisible(parsed.data.venueId))) {
    return { ok: false, error: "venue not visible" };
  }

  const r = await applyRetryFailed(adminDb(), {
    enquiryId: parsed.data.enquiryId,
    venueId: parsed.data.venueId,
  });
  if (!r.ok) return { ok: false, error: applyResultMessage(r) };

  await audit.log({
    organisationId: orgId,
    action: "enquiry.retried",
    actorUserId: userId,
    targetType: "enquiry",
    targetId: parsed.data.enquiryId,
    metadata: { venueId: parsed.data.venueId },
  });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries`);
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/enquiries/${parsed.data.enquiryId}`);
  return { ok: true };
}

function rejectionMessage(
  r:
    | { reason: "wrong-status"; current: string }
    | { reason: "no-draft" }
    | { reason: "not-stale-enough"; ageMs: number },
): string {
  switch (r.reason) {
    case "wrong-status":
      return `cannot perform action from status "${r.current}"`;
    case "no-draft":
      return "no draft to send";
    case "not-stale-enough":
      return `still parsing (age ${Math.round(r.ageMs / 1000)}s); try again shortly`;
  }
}

function applyResultMessage(r: Exclude<ApplyResult, { ok: true }>): string {
  switch (r.reason) {
    case "not-found":
      return "enquiry not found";
    case "wrong-status":
      return `cannot perform action from status "${r.current ?? "unknown"}"`;
    case "no-draft":
      return "no draft to send";
    case "not-stale-enough":
      return `still parsing (age ${Math.round((r.ageMs ?? 0) / 1000)}s); try again shortly`;
  }
}
