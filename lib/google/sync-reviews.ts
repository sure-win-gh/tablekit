// Pulls new Google reviews into our reviews table. Idempotent on the
// (venue_id, source, external_id) partial UNIQUE — re-running the
// sweep upserts existing rows so a corrected typo on the source side
// reflects on the next pull.
//
// Today the sweep runs as part of the existing nightly cron at
// /api/cron/deposit-janitor. Phase 3c adds finer cadence + a manual
// "Sync now" button on the dashboard.

import "server-only";

import { eq, isNotNull } from "drizzle-orm";

import { reviews, venueOauthConnections } from "@/lib/db/schema";
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
    upserted += await upsertReviews(conn.organisationId, conn.venueId, result.reviews);
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
  const rows = await db
    .select({ venueId: venueOauthConnections.venueId })
    .from(venueOauthConnections)
    .where(eq(venueOauthConnections.provider, "google"));
  // Filter to ones with a location id picked — the sync is a no-op
  // otherwise, but skipping the round-trip keeps cron logs clean.
  const withLocation = await db
    .select({ venueId: venueOauthConnections.venueId })
    .from(venueOauthConnections)
    .where(isNotNull(venueOauthConnections.externalAccountId));
  const wantSet = new Set(withLocation.map((r) => r.venueId));
  const targets = rows.filter((r) => wantSet.has(r.venueId));

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
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
    }
  }
  return outcomes;
}

// --- internals ---------------------------------------------------------------

async function upsertReviews(
  organisationId: string,
  venueId: string,
  fetchedReviews: GoogleReview[],
): Promise<number> {
  if (fetchedReviews.length === 0) return 0;
  const db = adminDb();
  let count = 0;
  for (const r of fetchedReviews) {
    const commentCipher = r.comment
      ? await encryptPii(organisationId, r.comment)
      : null;
    await db
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
        externalUrl: null,
        reviewerDisplayName: r.reviewer.displayName,
        submittedAt: new Date(r.createTime),
      })
      .onConflictDoUpdate({
        target: [reviews.venueId, reviews.source, reviews.externalId],
        set: {
          rating: starRatingToInt(r.starRating),
          commentCipher,
          reviewerDisplayName: r.reviewer.displayName,
          submittedAt: new Date(r.updateTime),
        },
      });
    count++;
  }
  return count;
}
