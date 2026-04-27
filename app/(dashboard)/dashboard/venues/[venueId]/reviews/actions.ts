"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { reviews } from "@/lib/db/schema";
import { replyToReview as replyToGoogleReview } from "@/lib/google/business-profile";
import { getActiveGoogleConnection } from "@/lib/google/connection";
import { processNextBatch } from "@/lib/messaging/dispatch";
import { enqueueMessage, truncateError } from "@/lib/messaging/enqueue";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { encryptPii } from "@/lib/security/crypto";

// Operator reply to a guest review.
// - internal source: claim → enqueue email → audit (transactional).
// - google source: claim → call Business Profile API → audit. The
//   claim is a conditional UPDATE that only matches rows where
//   responded_at IS NULL, so two near-simultaneous submissions can't
//   both proceed. If the API call fails we roll back the claim so a
//   retry can win.
//
// Replies are one-shot — the form disables once a row has a response.

const Schema = z.object({
  reviewId: z.uuid(),
  venueId: z.uuid(),
  reply: z.string().trim().min(1, "Write a reply.").max(800),
});

export type RespondToReviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

export async function respondToReview(
  _prev: RespondToReviewState,
  formData: FormData,
): Promise<RespondToReviewState> {
  const parsed = Schema.safeParse({
    reviewId: formData.get("review_id"),
    venueId: formData.get("venue_id"),
    reply: formData.get("reply"),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { status: "error", message: first?.message ?? "Invalid input." };
  }

  const { orgId, userId } = await requireRole("manager");
  const { reviewId, venueId, reply } = parsed.data;

  if (!(await assertVenueVisible(venueId))) {
    return { status: "error", message: "Review not found." };
  }

  const db = adminDb();
  const [row] = await db
    .select({
      id: reviews.id,
      bookingId: reviews.bookingId,
      source: reviews.source,
      externalId: reviews.externalId,
      respondedAt: reviews.respondedAt,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.id, reviewId),
        eq(reviews.organisationId, orgId),
        eq(reviews.venueId, venueId),
      ),
    )
    .limit(1);
  if (!row) return { status: "error", message: "Review not found." };
  if (row.respondedAt) return { status: "error", message: "Already replied." };

  const responseCipher = await encryptPii(orgId, reply);

  // Conditional claim — only one concurrent submission wins. Sets
  // both response_cipher and responded_at together to keep the
  // reviews_response_consistency_check satisfied at every stable
  // point. RETURNING tells us whether we won the race.
  const claimed = await db
    .update(reviews)
    .set({ responseCipher, respondedAt: sql`now()`, respondedByUserId: userId })
    .where(
      and(
        eq(reviews.id, row.id),
        eq(reviews.organisationId, orgId),
        eq(reviews.venueId, venueId),
        sql`${reviews.respondedAt} is null`,
      ),
    )
    .returning({ id: reviews.id });
  if (claimed.length === 0) return { status: "error", message: "Already replied." };

  if (row.source === "internal") {
    if (!row.bookingId) return { status: "error", message: "Internal review missing booking." };
    const internalBookingId = row.bookingId;
    await enqueueMessage({
      organisationId: orgId,
      bookingId: internalBookingId,
      template: "review.operator_reply",
      channel: "email",
    });
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "review.responded",
      targetType: "review",
      targetId: row.id,
      metadata: { venueId, source: "internal" },
    });
    void processNextBatch({ limit: 5 }).catch((err) => {
      console.error("[reviews/actions.ts] inline worker drive failed:", {
        message: truncateError(err),
      });
    });
  } else if (row.source === "google") {
    if (!row.externalId) {
      // Roll the claim back — we got further than expected.
      await rollbackClaim(row.id);
      return { status: "error", message: "Google review missing external id." };
    }
    const conn = await getActiveGoogleConnection(venueId);
    if (!conn || !conn.externalAccountId) {
      await rollbackClaim(row.id);
      return {
        status: "error",
        message: "Google connection lost. Reconnect in settings.",
      };
    }
    const apiResult = await replyToGoogleReview({
      accessToken: conn.accessToken,
      locationName: conn.externalAccountId,
      reviewId: row.externalId,
      comment: reply,
    });
    if (!apiResult.ok) {
      await rollbackClaim(row.id);
      return {
        status: "error",
        message: `Google rejected the reply (HTTP ${apiResult.status}).`,
      };
    }
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "review.responded",
      targetType: "review",
      targetId: row.id,
      metadata: { venueId, source: "google" },
    });
  } else {
    await rollbackClaim(row.id);
    return { status: "error", message: "Replies for this source aren't supported yet." };
  }

  revalidatePath(`/dashboard/venues/${venueId}/reviews`);
  return { status: "saved" };
}

// Release a previously-claimed reply row so a retry can win. Both
// columns nulled together to keep reviews_response_consistency_check
// satisfied; respondedByUserId nulled for hygiene.
async function rollbackClaim(reviewRowId: string): Promise<void> {
  await adminDb()
    .update(reviews)
    .set({ responseCipher: null, respondedAt: null, respondedByUserId: null })
    .where(eq(reviews.id, reviewRowId));
}

// --- sendRecoveryOffer (Phase 6) --------------------------------------------
// Operator-triggered "we'd like to make it right" outbound to the
// guest. Internal-source only — Google reviewers don't have a guest
// row in our DB, so there's nothing to email. Same conditional-claim
// pattern as respondToReview to defend against double-submit.

const RecoverySchema = z.object({
  reviewId: z.uuid(),
  venueId: z.uuid(),
  message: z.string().trim().min(1, "Write a message.").max(800),
});

export type SendRecoveryOfferState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

export async function sendRecoveryOffer(
  _prev: SendRecoveryOfferState,
  formData: FormData,
): Promise<SendRecoveryOfferState> {
  const parsed = RecoverySchema.safeParse({
    reviewId: formData.get("review_id"),
    venueId: formData.get("venue_id"),
    message: formData.get("message"),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { status: "error", message: first?.message ?? "Invalid input." };
  }

  const { orgId, userId } = await requireRole("manager");
  const { reviewId, venueId, message } = parsed.data;

  if (!(await assertVenueVisible(venueId))) {
    return { status: "error", message: "Review not found." };
  }

  const db = adminDb();
  const [row] = await db
    .select({
      id: reviews.id,
      bookingId: reviews.bookingId,
      source: reviews.source,
      recoveryOfferAt: reviews.recoveryOfferAt,
    })
    .from(reviews)
    .where(
      and(
        eq(reviews.id, reviewId),
        eq(reviews.organisationId, orgId),
        eq(reviews.venueId, venueId),
      ),
    )
    .limit(1);
  if (!row) return { status: "error", message: "Review not found." };
  if (row.source !== "internal" || !row.bookingId) {
    return {
      status: "error",
      message: "Recovery offers are only available for reviews collected via TableKit.",
    };
  }
  if (row.recoveryOfferAt) {
    return { status: "error", message: "Recovery offer already sent." };
  }

  const recoveryMessageCipher = await encryptPii(orgId, message);

  // Conditional claim — only one concurrent submission wins. Both
  // columns set together to satisfy reviews_recovery_consistency_check.
  const claimed = await db
    .update(reviews)
    .set({
      recoveryMessageCipher,
      recoveryOfferAt: sql`now()`,
      recoveryOfferedByUserId: userId,
    })
    .where(
      and(
        eq(reviews.id, row.id),
        eq(reviews.organisationId, orgId),
        sql`${reviews.recoveryOfferAt} is null`,
      ),
    )
    .returning({ id: reviews.id });
  if (claimed.length === 0) {
    return { status: "error", message: "Recovery offer already sent." };
  }

  await enqueueMessage({
    organisationId: orgId,
    bookingId: row.bookingId,
    template: "review.recovery_offer",
    channel: "email",
  });

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "review.recovery_sent",
    targetType: "review",
    targetId: row.id,
    metadata: { venueId },
  });

  void processNextBatch({ limit: 5 }).catch((err) => {
    console.error("[reviews/actions.ts] inline worker drive failed:", {
      message: truncateError(err),
    });
  });

  revalidatePath(`/dashboard/venues/${venueId}/reviews`);
  return { status: "saved" };
}
