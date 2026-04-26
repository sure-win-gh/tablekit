// createDsarRequest — write the public privacy-request form's payload
// into dsar_requests. Called from the rate-limited public action; the
// action handles captcha + IP throttling + org-slug → org_id resolution
// before reaching here.
//
// Side effects:
//   * Encrypt the requester's email + free-text message under the
//     organisation's DEK (encryptPii).
//   * Hash the email for matching to a future guests row without
//     decrypting at scrub time.
//   * Best-effort match against an existing guest row in the same org
//     by email hash — populates dsar_requests.guest_id when found, so
//     the operator inbox can show a direct link.
//   * Audit log entry.
//
// We don't decide whether to dedup on (org, email_hash, kind, status)
// — a guest who submits twice gets two rows so the operator sees the
// repeated request rather than one being silently dropped.

import "server-only";

import { and, eq } from "drizzle-orm";

import { dsarRequests, guests } from "@/lib/db/schema";
import { encryptPii, hashForLookup } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type DsarKind = "export" | "rectify" | "erase";

export type CreateDsarInput = {
  organisationId: string;
  kind: DsarKind;
  requesterEmail: string;
  message?: string | undefined;
};

export type CreateDsarResult =
  | { ok: true; dsarId: string; matchedGuestId: string | null }
  | { ok: false; reason: "invalid-input"; issues: string[] };

const MAX_MESSAGE = 2000;

// 30 days, matching the GDPR SLA. Tracked via due_at on the row so
// the operator inbox can sort + flag overdue requests.
const SLA_DAYS = 30;

export async function createDsarRequest(input: CreateDsarInput): Promise<CreateDsarResult> {
  const issues: string[] = [];
  const email = (input.requesterEmail ?? "").trim();
  if (!email || !/.+@.+\..+/.test(email)) issues.push("requesterEmail: invalid");
  if (input.message && input.message.length > MAX_MESSAGE) {
    issues.push(`message: must be ≤ ${MAX_MESSAGE} characters`);
  }
  if (!["export", "rectify", "erase"].includes(input.kind)) {
    issues.push("kind: must be export | rectify | erase");
  }
  if (issues.length > 0) return { ok: false, reason: "invalid-input", issues };

  const db = adminDb();
  const emailHash = hashForLookup(email, "email");

  // Try to match the requester to an existing guest in the same org so
  // the operator can jump straight to the profile. Best-effort: a miss
  // is fine, the operator can still action the request.
  const [matchedGuest] = await db
    .select({ id: guests.id })
    .from(guests)
    .where(and(eq(guests.organisationId, input.organisationId), eq(guests.emailHash, emailHash)))
    .limit(1);

  const requesterEmailCipher = await encryptPii(input.organisationId, email);
  const messageCipher = input.message
    ? await encryptPii(input.organisationId, input.message)
    : null;

  const dueAt = new Date(Date.now() + SLA_DAYS * 24 * 60 * 60 * 1000);

  const [inserted] = await db
    .insert(dsarRequests)
    .values({
      organisationId: input.organisationId,
      kind: input.kind,
      requesterEmailHash: emailHash,
      requesterEmailCipher,
      messageCipher,
      guestId: matchedGuest?.id ?? null,
      dueAt,
    })
    .returning({ id: dsarRequests.id });

  if (!inserted) {
    throw new Error("lib/dsar/create.ts: insert returned no row");
  }

  await audit.log({
    organisationId: input.organisationId,
    actorUserId: null,
    action: "dsar.created",
    targetType: "dsar_request",
    targetId: inserted.id,
    metadata: { kind: input.kind, matchedGuestId: matchedGuest?.id ?? null },
  });

  return { ok: true, dsarId: inserted.id, matchedGuestId: matchedGuest?.id ?? null };
}
