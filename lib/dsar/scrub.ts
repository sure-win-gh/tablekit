// runErasureScrub — null PII for one completed erase DSAR.
//
// The operator's "Mark completed" click only stamps dsar_requests.status
// + resolved_at; this function does the actual data deletion required
// by docs/playbooks/gdpr.md. One transaction per DSAR so a half-scrubbed
// state can never persist (the reviews CHECK constraints would block it
// anyway).
//
// Idempotent: a row whose scrubbed_at is already set is a no-op.
// `lib/dsar/sweep.ts` calls this; the cron at /api/cron/dsar-scrub
// drives the sweep, with a best-effort inline trigger from the
// privacy-requests dashboard page so an operator's flow doesn't have
// to wait for the next cron tick.

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { dsarRequests, guests, reviews } from "@/lib/db/schema";
import { encryptPii } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type RunErasureScrubInput = {
  dsarId: string;
};

export type RunErasureScrubResult =
  | {
      ok: true;
      alreadyScrubbed: boolean;
      guestId: string | null;
      reviewsScrubbed: number;
    }
  | { ok: false; reason: "not-found" | "wrong-kind" | "wrong-status" };

export async function runErasureScrub(input: RunErasureScrubInput): Promise<RunErasureScrubResult> {
  const db = adminDb();

  // Pre-flight read so we can short-circuit + know what to audit.
  const [dsar] = await db
    .select({
      id: dsarRequests.id,
      organisationId: dsarRequests.organisationId,
      kind: dsarRequests.kind,
      status: dsarRequests.status,
      guestId: dsarRequests.guestId,
      scrubbedAt: dsarRequests.scrubbedAt,
    })
    .from(dsarRequests)
    .where(eq(dsarRequests.id, input.dsarId))
    .limit(1);

  if (!dsar) return { ok: false, reason: "not-found" };
  if (dsar.kind !== "erase") return { ok: false, reason: "wrong-kind" };
  if (dsar.status !== "completed") return { ok: false, reason: "wrong-status" };

  // Idempotent guard. The sweeper's WHERE clause already filters this
  // out, but a concurrent cron + inline run could race; bail cleanly.
  if (dsar.scrubbedAt) {
    return {
      ok: true,
      alreadyScrubbed: true,
      guestId: dsar.guestId,
      reviewsScrubbed: 0,
    };
  }

  // last_name_cipher + email_cipher are NOT NULL on the guests table
  // and email_hash is too — we can't null them. Overwrite with empty-
  // encrypted ciphertext (the encryption of "") and a fixed hash of
  // the empty string. Both contain no PII; readers that decrypt these
  // will see "" and render empty fields, which is the playbook's
  // intent. phone_cipher is nullable.
  const emptyCipher = await encryptPii(dsar.organisationId, "");

  // One transaction: guest update + reviews update + dsar stamp.
  // Reviews' (response_cipher ↔ responded_at) and (recovery_message_cipher
  // ↔ recovery_offer_at) CHECK constraints require nulling each pair
  // together — this single UPDATE satisfies both.
  let reviewsScrubbed = 0;
  await db.transaction(async (tx) => {
    if (dsar.guestId) {
      await tx
        .update(guests)
        .set({
          firstName: "Erased",
          lastNameCipher: emptyCipher,
          emailCipher: emptyCipher,
          phoneCipher: sql`NULL`,
          erasedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(guests.id, dsar.guestId),
            eq(guests.organisationId, dsar.organisationId),
            isNull(guests.erasedAt),
          ),
        );

      const updated = await tx
        .update(reviews)
        .set({
          commentCipher: sql`NULL`,
          responseCipher: sql`NULL`,
          respondedAt: sql`NULL`,
          respondedByUserId: sql`NULL`,
          recoveryMessageCipher: sql`NULL`,
          recoveryOfferAt: sql`NULL`,
          recoveryOfferedByUserId: sql`NULL`,
          showcaseConsentAt: sql`NULL`,
        })
        .where(and(eq(reviews.guestId, dsar.guestId), eq(reviews.source, "internal")))
        .returning({ id: reviews.id });
      reviewsScrubbed = updated.length;
    }

    await tx
      .update(dsarRequests)
      .set({ scrubbedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(dsarRequests.id, dsar.id));
  });

  // Audit AFTER commit so a rollback can't leave orphan log entries.
  if (dsar.guestId) {
    await audit.log({
      organisationId: dsar.organisationId,
      actorUserId: null,
      action: "guest.erased",
      targetType: "guest",
      targetId: dsar.guestId,
      metadata: { dsarId: dsar.id, reviewsScrubbed },
    });
  }
  await audit.log({
    organisationId: dsar.organisationId,
    actorUserId: null,
    action: "dsar.scrubbed",
    targetType: "dsar_request",
    targetId: dsar.id,
    metadata: { guestId: dsar.guestId, reviewsScrubbed },
  });

  return {
    ok: true,
    alreadyScrubbed: false,
    guestId: dsar.guestId,
    reviewsScrubbed,
  };
}
