"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { reviews, venues } from "@/lib/db/schema";
import { enqueueMessage } from "@/lib/messaging/enqueue";
import { processNextBatch } from "@/lib/messaging/dispatch";
import { truncateError } from "@/lib/messaging/enqueue";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { encryptPii } from "@/lib/security/crypto";

// Operator reply to a guest review. The reply is stored encrypted on
// the review row and emailed via the existing dispatch worker. Replies
// are one-shot in Phase 2 — the form disables once a row has a
// response. Editing / multiple replies land later.

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

  // Per-venue scope check — `requireRole` only verifies org membership,
  // not the per-venue staff scoping from migration 0013. Without this,
  // a manager scoped to venue A could craft a POST with venue B's id
  // (same org) and respond on its behalf. withUser routes the lookup
  // through RLS (`user_visible_venue_ids()`), which honours
  // memberships.venue_ids.
  const venueVisible = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows.length > 0;
  });
  if (!venueVisible) return { status: "error", message: "Review not found." };

  const responseCipher = await encryptPii(orgId, reply);

  const db = adminDb();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: reviews.id,
        bookingId: reviews.bookingId,
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
    if (!row) return { ok: false as const, message: "Review not found." };
    if (row.respondedAt) return { ok: false as const, message: "Already replied." };

    await tx
      .update(reviews)
      .set({
        responseCipher,
        respondedAt: sql`now()`,
        respondedByUserId: userId,
      })
      .where(eq(reviews.id, row.id));

    // enqueueMessage is idempotent on (booking_id, template, channel),
    // so even if the transaction is retried by Postgres, we get one
    // queued row.
    await enqueueMessage({
      organisationId: orgId,
      bookingId: row.bookingId,
      template: "review.operator_reply",
      channel: "email",
    });

    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "review.responded",
      targetType: "review",
      targetId: row.id,
      metadata: { venueId },
    });

    return { ok: true as const };
  });

  if (!result.ok) return { status: "error", message: result.message };

  // Drive a small batch in the background so the operator's "Send
  // reply" button doesn't block on Resend latency. Cron sweeper picks
  // up anything missed; the inline drive is just a latency tweak.
  void processNextBatch({ limit: 5 }).catch((err) => {
    console.error("[reviews/actions.ts] inline worker drive failed:", {
      message: truncateError(err),
    });
  });

  revalidatePath(`/dashboard/venues/${venueId}/reviews`);
  return { status: "saved" };
}
