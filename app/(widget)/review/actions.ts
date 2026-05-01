"use server";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { bookings, reviews, venues } from "@/lib/db/schema";
import { sendEscalationAlertIfNeeded } from "@/lib/reviews/escalation";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { encryptPii } from "@/lib/security/crypto";
import { verifyReviewToken } from "@/lib/messaging/review-tokens";

// Public submission. Token is the only auth — verifyReviewToken does
// HMAC + constant-time compare and rejects expired tokens. RLS doesn't
// apply (adminDb()), so the token check + the booking-status guard
// carry the weight.
const Schema = z.object({
  p: z.string().min(1),
  s: z.string().min(1),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(800).optional(),
  // Phase 7a — public showcase consent. Optional, default false;
  // checkbox only POSTs "on" when ticked.
  showcaseConsent: z.coerce.boolean().optional(),
});

export type SubmitReviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved"; rating: number; googleReviewUrl: string | null };

export async function submitReview(
  _prev: SubmitReviewState,
  formData: FormData,
): Promise<SubmitReviewState> {
  const parsed = Schema.safeParse({
    p: formData.get("p"),
    s: formData.get("s"),
    rating: formData.get("rating"),
    comment: formData.get("comment"),
    showcaseConsent: formData.get("showcase_consent") === "on",
  });
  if (!parsed.success) return { status: "error", message: "Please pick a rating from 1 to 5." };

  const verified = verifyReviewToken(parsed.data.p, parsed.data.s);
  if (!verified.ok) {
    const message =
      verified.reason === "expired"
        ? "This review link has expired."
        : "This link looks invalid or expired.";
    return { status: "error", message };
  }
  const { bookingId } = verified.payload;

  const db = adminDb();
  const [row] = await db
    .select({
      bookingId: bookings.id,
      organisationId: bookings.organisationId,
      venueId: bookings.venueId,
      guestId: bookings.guestId,
      status: bookings.status,
      venueSettings: venues.settings,
    })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!row) return { status: "error", message: "Booking not found." };

  // Status guard — only finished bookings can be reviewed. Stops a
  // valid token from rating a future-confirmed or cancelled booking.
  if (row.status !== "finished") {
    return { status: "error", message: "This booking can't be reviewed." };
  }

  // First-submit-wins. A leaked email link can be replayed, but the
  // first submission is what stays — no silent overwrites a year on.
  // We still resolve the Google CTA so a guest who clicked twice gets
  // the same downstream experience.
  const [existing] = await db
    .select({ rating: reviews.rating })
    .from(reviews)
    .where(eq(reviews.bookingId, row.bookingId))
    .limit(1);

  if (!existing) {
    const trimmed = (parsed.data.comment ?? "").trim();
    const commentCipher = trimmed.length > 0 ? await encryptPii(row.organisationId, trimmed) : null;

    const [inserted] = await db
      .insert(reviews)
      .values({
        organisationId: row.organisationId, // overwritten by enforce trigger
        venueId: row.venueId, // overwritten by enforce trigger
        bookingId: row.bookingId,
        guestId: row.guestId,
        rating: parsed.data.rating,
        commentCipher,
        source: "internal",
        // Stamp consent at write time so the timestamp matches the
        // submission (not the moment a future audit runs).
        showcaseConsentAt: parsed.data.showcaseConsent ? sql`now()` : null,
      })
      .returning({ id: reviews.id });

    await audit.log({
      organisationId: row.organisationId,
      actorUserId: null,
      action: "review.submitted",
      targetType: "review",
      targetId: row.bookingId,
      metadata: { rating: parsed.data.rating, venueId: row.venueId },
    });

    // Fire-and-forget — escalation must not block the guest's
    // submission flow. The helper swallows errors and stamps
    // escalation_alert_at idempotently.
    if (inserted) {
      void sendEscalationAlertIfNeeded(inserted.id);
    }
  }
  // No else-branch: subsequent submits are silently ignored. The
  // guest still sees the thank-you screen so a double-click doesn't
  // confuse them.

  // Build the Google deep link only if the venue configured a Place ID.
  // Per Google policy, we offer it regardless of rating — emphasis,
  // not gating, is what we control.
  const settings = (row.venueSettings ?? {}) as Record<string, unknown>;
  const placeId = settings["googlePlaceId"];
  const googleReviewUrl =
    typeof placeId === "string" && placeId.length > 0
      ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`
      : null;

  return {
    status: "saved",
    rating: existing?.rating ?? parsed.data.rating,
    googleReviewUrl,
  };
}

// Called when the guest clicks the post-submit Google CTA. Records the
// click so the operator dashboard (Phase 2) can show conversion rate.
// Best-effort: the redirect may race the action, so don't depend on
// the metric being lossless.
export async function markRedirectedToGoogle(p: string, s: string): Promise<void> {
  const verified = verifyReviewToken(p, s);
  if (!verified.ok) return;
  const db = adminDb();
  await db
    .update(reviews)
    .set({ redirectedToExternal: true })
    .where(eq(reviews.bookingId, verified.payload.bookingId));
}
