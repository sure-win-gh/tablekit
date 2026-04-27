"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { reviews } from "@/lib/db/schema";
import { enqueueMessage } from "@/lib/messaging/enqueue";
import { processNextBatch } from "@/lib/messaging/dispatch";
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

  const db = adminDb();
  // The compound WHERE on org + venue + review id is what stops a
  // crafted reviewId from poking another tenant's row — adminDb()
  // bypasses RLS, so this check carries the weight.
  const [row] = await db
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
  if (!row) return { status: "error", message: "Review not found." };
  if (row.respondedAt) return { status: "error", message: "Already replied." };

  const responseCipher = await encryptPii(orgId, reply);

  await db
    .update(reviews)
    .set({
      responseCipher,
      respondedAt: sql`now()`,
      respondedByUserId: userId,
    })
    .where(eq(reviews.id, row.id));

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

  // Drive a small batch immediately so the email lands in seconds —
  // matches the inline-drive pattern from booking-confirmation.
  try {
    await processNextBatch({ limit: 5 });
  } catch (err) {
    console.error("[reviews/actions.ts] inline worker drive failed:", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  revalidatePath(`/dashboard/venues/${venueId}/reviews`);
  return { status: "saved" };
}
