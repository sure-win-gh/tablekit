// Google Business Profile reviews API — narrow client for what Phase
// 3b actually needs. Native fetch; no googleapis SDK.
//
// API surface used:
//   GET https://mybusiness.googleapis.com/v4/{location}/reviews
//   PUT https://mybusiness.googleapis.com/v4/{location}/reviews/{reviewId}/reply  (Phase 3c)
//
// `location` is the resource name `accounts/{accountId}/locations/{locationId}`.
// The operator picks the location during connect (Phase 3c will add
// the picker UI; today the column lives on venue_oauth_connections
// and is populated manually in dev).

import "server-only";

import { GOOGLE_FETCH_TIMEOUT_MS } from "@/lib/oauth/google";

export type GoogleReview = {
  reviewId: string; // stable per review — used as our external_id
  reviewer: { displayName: string };
  starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
  comment: string | null;
  createTime: string; // ISO8601
  updateTime: string;
  reviewReply?: { comment: string; updateTime: string } | null;
  // Public URL on Google. The v4 API returns a relative `name` field;
  // we synthesise the user-facing URL at consumption time using the
  // location's place id (handled by callers).
  name: string;
};

export type ListReviewsResult =
  | { ok: true; reviews: GoogleReview[]; nextPageToken: string | null }
  | { ok: false; status: number };

const STAR_TO_INT: Record<GoogleReview["starRating"], number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function starRatingToInt(s: GoogleReview["starRating"]): number {
  return STAR_TO_INT[s];
}

// --- Account + location listing (Phase 3c picker) ----------------------------

export type GoogleAccount = {
  name: string; // resource name "accounts/{accountId}"
  accountName: string; // human-readable
  type: string;
};

export type GoogleLocation = {
  name: string; // resource name "locations/{locationId}" — note: relative
  title: string; // human-readable display name
  storefrontAddress?: { addressLines?: string[]; locality?: string };
};

export async function listAccounts(
  accessToken: string,
): Promise<{ ok: true; accounts: GoogleAccount[] } | { ok: false; status: number }> {
  const res = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const json = (await res.json()) as { accounts?: GoogleAccount[] };
  return { ok: true, accounts: json.accounts ?? [] };
}

export async function listLocations(input: {
  accessToken: string;
  accountName: string; // "accounts/{accountId}"
}): Promise<{ ok: true; locations: GoogleLocation[] } | { ok: false; status: number }> {
  // readMask is required by the v1 endpoint; ask for the bare minimum.
  const url = new URL(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${input.accountName}/locations`,
  );
  url.searchParams.set("readMask", "name,title,storefrontAddress");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${input.accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const json = (await res.json()) as { locations?: GoogleLocation[] };
  return { ok: true, locations: json.locations ?? [] };
}

// --- Review reply (Phase 3c) -------------------------------------------------

export async function replyToReview(input: {
  accessToken: string;
  locationName: string; // "accounts/{accountId}/locations/{locationId}"
  reviewId: string;
  comment: string;
}): Promise<{ ok: true } | { ok: false; status: number }> {
  const url = `https://mybusiness.googleapis.com/v4/${input.locationName}/reviews/${encodeURIComponent(
    input.reviewId,
  )}/reply`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ comment: input.comment }),
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true };
}

// --- Existing: list reviews --------------------------------------------------

export async function listReviews(input: {
  accessToken: string;
  locationName: string; // e.g. "accounts/123/locations/456"
  pageToken?: string | null;
}): Promise<ListReviewsResult> {
  const url = new URL(`https://mybusiness.googleapis.com/v4/${input.locationName}/reviews`);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  // Page size is API-default; Google caps at 50 per page.

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const json = (await res.json()) as {
    reviews?: GoogleReview[];
    nextPageToken?: string;
  };
  return {
    ok: true,
    reviews: json.reviews ?? [],
    nextPageToken: json.nextPageToken ?? null,
  };
}
