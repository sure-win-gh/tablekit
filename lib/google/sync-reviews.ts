// Pulls new Google reviews into our reviews table. Idempotent on the
// (venue_id, source, external_id) partial UNIQUE — re-running the
// sweep upserts existing rows so a corrected typo on the source side
// reflects on the next pull.
//
// Today the sweep runs as part of the existing nightly cron at
// /api/cron/deposit-janitor. Phase 3c adds finer cadence + a manual
// "Sync now" button on the dashboard.

import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { reviews, venueOauthConnections, venues } from "@/lib/db/schema";
import { sendEscalationAlertIfNeeded } from "@/lib/reviews/escalation";
import { adminDb } from "@/lib/server/admin/db";
import { encryptPii } from "@/lib/security/crypto";

import {
  listReviews,
  starRatingToInt,
  type GoogleReview,
} from "./business-profile";
import { getActiveGoogleConnection, markVenueSynced } from "./connection";

export type SyncOutcome = {
  venueId: string;
  ok: boolean;
  fetched: number;
  upserted: number;
  reason?: string;
};

export async function syncGoogleReviewsForVenue(venueId: string): Promise<SyncOutcome> {
  const conn = await getActiveGoogleConnection(venueId);
  if (!conn) return { venueId, ok: false, fetched: 0, upserted: 0, reason: "no-connection" };
  if (!conn.externalAccountId) {
    // Operator hasn't picked a location yet (Phase 3c flow). No-op.
    return { venueId, ok: true, fetched: 0, upserted: 0, reason: "no-location" };
  }

  // Read the venue's googlePlaceId once per sync — it drives the
  // public review URL we set on each imported row.
  const placeId = await loadVenuePlaceId(venueId);

  let fetched = 0;
  let upserted = 0;
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await listReviews({
      accessToken: conn.accessToken,
      locationName: conn.externalAccountId,
      pageToken,
    });
    if (!result.ok) {
      return {
        venueId,
        ok: false,
        fetched,
        upserted,
        reason: `api-${result.status}`,
      };
    }
    fetched += result.reviews.length;
    upserted += await upsertReviews(
      conn.organisationId,
      conn.venueId,
      result.reviews,
      placeId,
    );
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }

  await markVenueSynced(venueId);
  return { venueId, ok: true, fetched, upserted };
}

// Sweeps every venue with a Google connection. Returns one outcome
// per venue so callers can log / aggregate without re-querying. Errors
// in one venue don't abort the others — the connection table will
// have stale `last_synced_at` for the failed venue, and the next
// sweep retries naturally.
export async function syncAllConnectedGoogleVenues(): Promise<SyncOutcome[]> {
  const db = adminDb();
  const targets = await db
    .select({ venueId: venueOauthConnections.venueId })
    .from(venueOauthConnections)
    .where(
      and(
        eq(venueOauthConnections.provider, "google"),
        isNotNull(venueOauthConnections.externalAccountId),
      ),
    );

  const outcomes: SyncOutcome[] = [];
  for (const target of targets) {
    try {
      outcomes.push(await syncGoogleReviewsForVenue(target.venueId));
    } catch (err) {
      outcomes.push({
        venueId: target.venueId,
        ok: false,
        fetched: 0,
        upserted: 0,
        // First line, length-capped, no `cause` chain. undici's
        // "fetch failed" can attach a cause whose message includes
        // the request URL — we don't put tokens in URLs (we use
        // Authorization headers) but we still don't want the chain
        // sliding into cron-response logs.
        reason: safeReason(err),
      });
    }
  }
  return outcomes;
}

function safeReason(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const firstLine = err.message.split("\n", 1)[0] ?? "";
  return `${err.constructor.name}: ${firstLine.slice(0, 120)}`;
}

// --- internals ---------------------------------------------------------------

async function loadVenuePlaceId(venueId: string): Promise<string | null> {
  const [row] = await adminDb()
    .select({ settings: venues.settings })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  if (!row) return null;
  const s = (row.settings ?? {}) as Record<string, unknown>;
  const v = s["googlePlaceId"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function buildExternalUrl(placeId: string | null): string | null {
  return placeId
    ? `https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`
    : null;
}

async function upsertReviews(
  organisationId: string,
  venueId: string,
  fetchedReviews: GoogleReview[],
  placeId: string | null,
): Promise<number> {
  if (fetchedReviews.length === 0) return 0;
  const db = adminDb();
  const externalUrl = buildExternalUrl(placeId);
  let count = 0;
  for (const r of fetchedReviews) {
    const commentCipher = r.comment
      ? await encryptPii(organisationId, r.comment)
      : null;
    // submittedAt is set on insert from createTime and never moved on
    // conflict — keeping the desc-order stable when a guest edits an
    // old review. updated_at on the row is the source of truth for
    // "we last saw this version".
    const [upserted] = await db
      .insert(reviews)
      .values({
        organisationId, // overwritten by enforce trigger using venue's org
        venueId,
        bookingId: null,
        guestId: null,
        rating: starRatingToInt(r.starRating),
        commentCipher,
        source: "google",
        externalId: r.reviewId,
        externalUrl,
        reviewerDisplayName: r.reviewer.displayName,
        submittedAt: new Date(r.createTime),
      })
      .onConflictDoUpdate({
        target: [reviews.venueId, reviews.source, reviews.externalId],
        set: {
          rating: starRatingToInt(r.starRating),
          commentCipher,
          reviewerDisplayName: r.reviewer.displayName,
          externalUrl,
        },
      })
      .returning({ id: reviews.id });
    // Fire escalation alert for low ratings. Idempotent on
    // escalation_alert_at, so re-running on the same row is safe.
    if (upserted) {
      await sendEscalationAlertIfNeeded(upserted.id);
    }
    count++;
  }
  return count;
}
