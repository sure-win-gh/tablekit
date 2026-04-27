// Phase 6 — escalation alert.
//
// When a review with rating <= venue.settings.escalationThreshold
// lands (internal submission or external sync), email the operator
// once. Idempotency lives on the review row's escalation_alert_at
// column: a conditional UPDATE …WHERE escalation_alert_at IS NULL
// claims the alert, so a re-sync of the same external row doesn't
// fire twice.
//
// The alert recipient comes from venue.settings.escalationEmail.
// Falls back to the org owner's email (users.email — already
// plaintext per existing convention) so the feature works out of
// the box. If neither is available, we silently no-op rather than
// throw — operational alerts must not block the submission flow.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { reviews, memberships, users, venues } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/send";
import { renderReviewEscalationAlert } from "@/lib/email/templates/review-escalation-alert";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";

const COMMENT_SNIPPET_LEN = 280;

export async function sendEscalationAlertIfNeeded(reviewId: string): Promise<void> {
  try {
    await trySendAlert(reviewId);
  } catch (err) {
    // Operational telemetry — don't surface to the caller. The review
    // is already inserted; missing an alert is a soft failure.
    console.error("[lib/reviews/escalation.ts] alert failed:", {
      message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      reviewId,
    });
  }
}

async function trySendAlert(reviewId: string): Promise<void> {
  const db = adminDb();
  const [row] = await db
    .select({
      id: reviews.id,
      organisationId: reviews.organisationId,
      venueId: reviews.venueId,
      rating: reviews.rating,
      source: reviews.source,
      commentCipher: reviews.commentCipher,
      reviewerDisplayName: reviews.reviewerDisplayName,
      escalationAlertAt: reviews.escalationAlertAt,
      venueName: venues.name,
      venueSettings: venues.settings,
    })
    .from(reviews)
    .innerJoin(venues, eq(venues.id, reviews.venueId))
    .where(eq(reviews.id, reviewId))
    .limit(1);
  if (!row) return;
  if (row.escalationAlertAt) return; // already alerted

  const settings = (row.venueSettings ?? {}) as Record<string, unknown>;
  const enabled = settings["escalationEnabled"] !== false;
  if (!enabled) return;
  const threshold = parseThreshold(settings["escalationThreshold"]);
  if (row.rating > threshold) return;

  const recipient = await resolveRecipient(row.organisationId, settings);
  if (!recipient) return;

  // Claim the alert atomically — the conditional UPDATE means a
  // concurrent caller (re-sync after a failed first attempt) can't
  // both send. If we win, we proceed to render+send; if we lose, we
  // bail.
  const claimed = await db
    .update(reviews)
    .set({ escalationAlertAt: sql`now()` })
    .where(and(eq(reviews.id, row.id), sql`${reviews.escalationAlertAt} is null`))
    .returning({ id: reviews.id });
  if (claimed.length === 0) return;

  let commentSnippet: string | null = null;
  if (row.commentCipher) {
    try {
      const full = await decryptPii(row.organisationId, row.commentCipher as Ciphertext);
      commentSnippet =
        full.length > COMMENT_SNIPPET_LEN ? full.slice(0, COMMENT_SNIPPET_LEN - 1) + "…" : full;
    } catch {
      commentSnippet = null;
    }
  }

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const dashboardUrl = `${appUrl}/dashboard/venues/${row.venueId}/reviews`;
  // Unsubscribe-from-alerts URL points at venue settings — operators
  // toggle the feature off there. Re-uses the layout's unsubscribe
  // slot rather than introducing a new email-shape just for alerts.
  const unsubscribeUrl = `${appUrl}/dashboard/venues/${row.venueId}/settings#escalation`;

  const rendered = await renderReviewEscalationAlert({
    venueName: row.venueName,
    rating: row.rating,
    source: row.source,
    commentSnippet,
    reviewerName: row.reviewerDisplayName,
    dashboardUrl,
    unsubscribeUrl,
  });

  await sendEmail({
    to: recipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    unsubscribeUrl,
    // Idempotency at the provider level too: review id is stable.
    idempotencyKey: `review-escalation-${row.id}`,
  });

  await audit.log({
    organisationId: row.organisationId,
    actorUserId: null,
    action: "review.escalated",
    targetType: "review",
    targetId: row.id,
    metadata: { rating: row.rating, source: row.source, venueId: row.venueId },
  });
}

function parseThreshold(raw: unknown): number {
  if (typeof raw === "number" && raw >= 1 && raw <= 5) return Math.floor(raw);
  return 2; // default — alert on 1- and 2-star
}

async function resolveRecipient(
  organisationId: string,
  settings: Record<string, unknown>,
): Promise<string | null> {
  const configured = settings["escalationEmail"];
  if (typeof configured === "string" && configured.length > 0) return configured;
  // Fallback: an owner's email (plaintext per existing convention).
  const db = adminDb();
  const [row] = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(eq(memberships.organisationId, organisationId), eq(memberships.role, "owner")),
    )
    .limit(1);
  return row?.email ?? null;
}
