"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { reviews, venues } from "@/lib/db/schema";
import { replyToReview as replyToGoogleReview } from "@/lib/google/business-profile";
import { getActiveGoogleConnection } from "@/lib/google/connection";
import { processNextBatch } from "@/lib/messaging/dispatch";
import { enqueueMessage, truncateError } from "@/lib/messaging/enqueue";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { encryptPii } from "@/lib/security/crypto";

// Operator reply to a guest review.
// - internal source: persist encrypted reply + enqueue email.
// - google source (Phase 3c): persist encrypted reply + post to the
//   Business Profile API. The API call lives outside the DB
//   transaction (HTTP can't participate); we only persist after a
//   successful POST so we don't claim "replied" on a failed send.
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

  // Per-venue scope check — `requireRole` only verifies org membership.
  const venueVisible = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows.length > 0;
  });
  if (!venueVisible) return { status: "error", message: "Review not found." };

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

  if (row.source === "internal") {
    if (!row.bookingId) return { status: "error", message: "Internal review missing booking." };
    const internalBookingId = row.bookingId;
    await db.transaction(async (tx) => {
      await tx
        .update(reviews)
        .set({ responseCipher, respondedAt: sql`now()`, respondedByUserId: userId })
        .where(eq(reviews.id, row.id));
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
    });
    void processNextBatch({ limit: 5 }).catch((err) => {
      console.error("[reviews/actions.ts] inline worker drive failed:", {
        message: truncateError(err),
      });
    });
  } else if (row.source === "google") {
    if (!row.externalId) {
      return { status: "error", message: "Google review missing external id." };
    }
    const conn = await getActiveGoogleConnection(venueId);
    if (!conn || !conn.externalAccountId) {
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
      return {
        status: "error",
        message: `Google rejected the reply (HTTP ${apiResult.status}).`,
      };
    }
    // API accepted — persist locally so the dashboard reflects it. If
    // the audit insert fails after the API succeeded the operator
    // sees a stale "Reply" button on next render; one-shot semantics
    // mean a re-send would 409 against Google or no-op cleanly.
    await db.transaction(async (tx) => {
      await tx
        .update(reviews)
        .set({ responseCipher, respondedAt: sql`now()`, respondedByUserId: userId })
        .where(eq(reviews.id, row.id));
      await audit.log({
        organisationId: orgId,
        actorUserId: userId,
        action: "review.responded",
        targetType: "review",
        targetId: row.id,
        metadata: { venueId, source: "google" },
      });
    });
  } else {
    return { status: "error", message: "Replies for this source aren't supported yet." };
  }

  revalidatePath(`/dashboard/venues/${venueId}/reviews`);
  return { status: "saved" };
}
