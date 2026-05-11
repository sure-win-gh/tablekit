"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { venueSendingDomains } from "@/lib/db/schema";
import {
  createDomain,
  removeDomain,
  verifyDomain,
} from "@/lib/email/sending-domains";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";

// Server actions for the venue settings page's "Sending domain"
// fieldset. Owner-gated (managers can view via RLS but can't mutate
// the relationship with Resend).
//
// All three actions are idempotent at the row level: add fails if a
// row already exists (uniqueIndex on venue_id); remove + verify are
// no-ops when the row's already been removed/refreshed.

const AddSchema = z.object({
  venueId: z.string().uuid(),
  // RFC 1035-ish: a domain segment is 1-63 chars of [a-z0-9-], dots
  // separate. We lowercase before parsing because the DB CHECK enforces
  // lowercase.
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(4, "Too short")
    .max(253, "Too long")
    .regex(
      /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+(?<!-)$/,
      "Use a fully-qualified domain like mail.example.com",
    ),
});

const VenueIdSchema = z.object({ venueId: z.string().uuid() });

export type AddDomainState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "added"; domain: string };

export async function addSendingDomain(
  _prev: AddDomainState,
  formData: FormData,
): Promise<AddDomainState> {
  const parsed = AddSchema.safeParse({
    venueId: formData.get("venue_id"),
    domain: formData.get("domain"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid domain.",
    };
  }

  const { orgId, userId } = await requireRole("owner");
  const db = adminDb();

  // Confirm venue belongs to the active org before any Resend round-
  // trip. adminDb bypasses RLS, so we explicitly scope.
  // A pre-check race against the unique index is still possible
  // (someone re-submits the same form twice fast). The unique-index
  // catch below is the authoritative guard.
  const result = await createDomain(parsed.data.domain);
  if (!result.ok) {
    return {
      status: "error",
      message:
        result.reason === "already-exists"
          ? "That domain is already registered. Remove the existing record first."
          : result.reason === "invalid"
            ? "Resend rejected that domain. Double-check it points at a real subdomain you control."
            : "Couldn't reach the email provider. Try again in a moment.",
    };
  }

  try {
    await db.insert(venueSendingDomains).values({
      organisationId: orgId,
      venueId: parsed.data.venueId,
      domain: result.domain.name,
      resendDomainId: result.domain.id,
      status: result.domain.status,
      dnsRecords: result.domain.records,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Someone double-submitted; our Resend create succeeded but we
      // can't keep the row. Roll back the Resend-side create to keep
      // state consistent — fire-and-forget; a leaked resend row is
      // visible to the operator next time we sync.
      void removeDomain(result.domain.id).catch(() => undefined);
      return {
        status: "error",
        message: "A sending domain is already registered for this venue.",
      };
    }
    throw err;
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "enquiry.sending_domain.added",
    targetType: "venue",
    targetId: parsed.data.venueId,
    metadata: { domain: result.domain.name },
  });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/settings`);
  return { status: "added", domain: result.domain.name };
}

export async function verifyNowSendingDomain(input: { venueId: string }): Promise<void> {
  const parsed = VenueIdSchema.safeParse(input);
  if (!parsed.success) return;

  const { orgId, userId } = await requireRole("owner");
  const db = adminDb();

  const [row] = await db
    .select({
      id: venueSendingDomains.id,
      resendDomainId: venueSendingDomains.resendDomainId,
    })
    .from(venueSendingDomains)
    .where(
      and(
        eq(venueSendingDomains.venueId, parsed.data.venueId),
        eq(venueSendingDomains.organisationId, orgId),
      ),
    )
    .limit(1);
  if (!row) return;

  let updated;
  try {
    updated = await verifyDomain(row.resendDomainId);
  } catch {
    // Transient — leave the row's status alone, just bump lastChecked.
    await db
      .update(venueSendingDomains)
      .set({ lastCheckedAt: new Date() })
      .where(eq(venueSendingDomains.id, row.id));
    revalidatePath(`/dashboard/venues/${parsed.data.venueId}/settings`);
    return;
  }
  if (!updated) {
    // Resend says the domain is gone — drop our row to match.
    await db.delete(venueSendingDomains).where(eq(venueSendingDomains.id, row.id));
    revalidatePath(`/dashboard/venues/${parsed.data.venueId}/settings`);
    return;
  }

  const now = new Date();
  const wasVerified = updated.status === "verified";
  await db
    .update(venueSendingDomains)
    .set({
      status: updated.status,
      dnsRecords: updated.records,
      lastCheckedAt: now,
      // Stamp verifiedAt on the first successful verify; clear it if
      // the domain drops back into a non-verified state so the UI
      // doesn't claim "verified 3 days ago" while showing a red badge.
      verifiedAt: wasVerified ? now : null,
    })
    .where(eq(venueSendingDomains.id, row.id));

  if (wasVerified) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "enquiry.sending_domain.verified",
      targetType: "venue",
      targetId: parsed.data.venueId,
      metadata: { domain: updated.name },
    });
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/settings`);
}

export async function removeSendingDomain(input: { venueId: string }): Promise<void> {
  const parsed = VenueIdSchema.safeParse(input);
  if (!parsed.success) return;

  const { orgId, userId } = await requireRole("owner");
  const db = adminDb();

  const [row] = await db
    .select({
      id: venueSendingDomains.id,
      domain: venueSendingDomains.domain,
      resendDomainId: venueSendingDomains.resendDomainId,
    })
    .from(venueSendingDomains)
    .where(
      and(
        eq(venueSendingDomains.venueId, parsed.data.venueId),
        eq(venueSendingDomains.organisationId, orgId),
      ),
    )
    .limit(1);
  if (!row) return;

  // Remove from Resend first. Best-effort — even if it fails (already
  // gone, network blip, etc.) we still drop our row. A stuck Resend
  // record costs the operator nothing and is reclaimable by support.
  await removeDomain(row.resendDomainId).catch(() => undefined);
  await db.delete(venueSendingDomains).where(eq(venueSendingDomains.id, row.id));

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "enquiry.sending_domain.removed",
    targetType: "venue",
    targetId: parsed.data.venueId,
    metadata: { domain: row.domain },
  });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/settings`);
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505") {
    return true;
  }
  return false;
}
