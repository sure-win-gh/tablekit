// Google Places API (New v1) — narrow client for the outreach
// pre-populated-accounts flow. Native fetch; no googleapis SDK.
//
// API surface used:
//   POST https://places.googleapis.com/v1/places:searchText
//        — text search restricted to GB to find a prospect's venue.
//   GET  https://places.googleapis.com/v1/places/{placeId}
//        — fetch the venue's public details (hours, address, types).
//
// Auth: a server-side API key in the `X-Goog-Api-Key` header. The key
// is the platform's, not the operator's — outreach is internal and the
// caller is always the founder via the /admin/outreach UI. Never expose
// this key to the browser; restrict it to "Places API (New)" in the
// Google Cloud Console and to the production server's IP.
//
// Field masks: Places (New) requires `X-Goog-FieldMask` on every call.
// We request only the fields lib/outreach/build-from-places.ts uses —
// extra fields would bill us for data we throw away.

import "server-only";

import { GOOGLE_FETCH_TIMEOUT_MS } from "@/lib/oauth/google";

// --- Configuration -----------------------------------------------------------

function apiKey(): string | null {
  const key = process.env["GOOGLE_PLACES_API_KEY"];
  return key && key.trim() !== "" ? key : null;
}

export function isConfigured(): boolean {
  return apiKey() !== null;
}

// --- Types -------------------------------------------------------------------

export type PlaceSummary = {
  // Stable opaque ID, e.g. "ChIJ..."; persisted on organisations.outreach_source.
  id: string;
  displayName: string;
  formattedAddress: string;
};

// Opening-hours period as returned by the Places API. `day` is 0=Sunday
// through 6=Saturday (Google's convention, not ISO). `hour`/`minute`
// are local-to-the-venue. A 24-hour day shows up as a single period
// with no `close` block.
export type PlaceOpeningPeriod = {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
};

export type PlaceDetails = {
  id: string;
  displayName: string;
  formattedAddress: string;
  internationalPhoneNumber: string | null;
  websiteUri: string | null;
  // Empty array if the venue has no published hours.
  regularOpeningPeriods: PlaceOpeningPeriod[];
  // Google's `types` array — used by inferVenueType() to pick
  // café/restaurant/bar_pub. Always lowercase snake_case.
  types: string[];
  // ISO 6709-ish lat/lng. Stored as { lat, lng } not the wire shape
  // `{ latitude, longitude }` for ergonomic consumption.
  location: { lat: number; lng: number } | null;
};

// `status: number`            — wire status from Google (5xx, 403, etc).
// `status: "not-configured"`  — GOOGLE_PLACES_API_KEY unset.
// `status: "malformed-response"` — Google responded 2xx with a body
//   missing fields we need. Distinct from a wire 502 so PR 4's UI can
//   surface "Google changed something; tell support" rather than a
//   transient 5xx.
export type FailureStatus = number | "not-configured" | "malformed-response";

export type SearchResult =
  | { ok: true; places: PlaceSummary[] }
  | { ok: false; status: FailureStatus; error?: string };

export type DetailsResult =
  | { ok: true; place: PlaceDetails }
  | { ok: false; status: FailureStatus; error?: string };

// Build the failure variant. Google's REST errors come back as
// `{ error: { code, message, status } }`; we surface `message` only so
// the caller (PR 4 UI) doesn't echo the entire envelope into logs.
// Reading the body is best-effort — never fails the whole call.
async function failure(res: Response): Promise<{ ok: false; status: number; error?: string }> {
  const body = await res.text().catch(() => null);
  if (body === null || body === "") return { ok: false, status: res.status };
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return { ok: false, status: res.status, error: message };
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return { ok: false, status: res.status, error: body };
}

// --- searchText --------------------------------------------------------------

const SEARCH_FIELD_MASK = "places.id,places.displayName,places.formattedAddress";

type WireSearchResponse = {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
  }>;
};

// Bias the search to GB so a prospect query like "Padella" surfaces
// the London restaurant rather than a same-named overseas place.
const REGION_CODE = "GB";

export async function searchPlaces(query: string): Promise<SearchResult> {
  const key = apiKey();
  if (!key) return { ok: false, status: "not-configured" };

  const trimmed = query.trim();
  if (trimmed === "") return { ok: true, places: [] };

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: trimmed, regionCode: REGION_CODE }),
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) return failure(res);

  const json = (await res.json()) as WireSearchResponse;
  const raw = json.places ?? [];
  const places = raw
    .map((p): PlaceSummary | null => {
      const id = p.id;
      const displayName = p.displayName?.text;
      const formattedAddress = p.formattedAddress;
      if (!id || !displayName || !formattedAddress) return null;
      return { id, displayName, formattedAddress };
    })
    .filter((p): p is PlaceSummary => p !== null);

  // If Google starts shipping entries without the fields we asked for,
  // that's a contract change we want to notice. Log shapes only — no
  // PII (a venue name from a search the founder ran is not PII).
  const dropped = raw.length - places.length;
  if (dropped > 0) {
    console.warn(`places:searchText dropped ${dropped} malformed entr${dropped === 1 ? "y" : "ies"}`);
  }

  return { ok: true, places };
}

// --- place details -----------------------------------------------------------

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "internationalPhoneNumber",
  "websiteUri",
  "regularOpeningHours",
  "types",
  "location",
].join(",");

type WirePlaceDetails = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: {
    periods?: PlaceOpeningPeriod[];
  };
  types?: string[];
  location?: { latitude?: number; longitude?: number };
};

export async function getPlaceDetails(placeId: string): Promise<DetailsResult> {
  const key = apiKey();
  if (!key) return { ok: false, status: "not-configured" };

  // Place IDs are opaque but URL-safe in practice; encode defensively
  // in case Google ever introduces non-ASCII variants.
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;

  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) return failure(res);

  const json = (await res.json()) as WirePlaceDetails;
  if (!json.id || !json.displayName?.text || !json.formattedAddress) {
    return {
      ok: false,
      status: "malformed-response",
      error: "places-api: response missing required fields",
    };
  }

  const lat = json.location?.latitude;
  const lng = json.location?.longitude;
  const location = typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;

  return {
    ok: true,
    place: {
      id: json.id,
      displayName: json.displayName.text,
      formattedAddress: json.formattedAddress,
      internationalPhoneNumber: json.internationalPhoneNumber ?? null,
      websiteUri: json.websiteUri ?? null,
      regularOpeningPeriods: json.regularOpeningHours?.periods ?? [],
      types: json.types ?? [],
      location,
    },
  };
}
