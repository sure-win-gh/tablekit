// Public availability endpoint.
//
// GET /api/v1/availability?venue_id=…&date=…&party_size=…
//
// Anonymous + IP rate-limited (same posture as the widget POST).
// Returns ISO-8601 UTC timestamps for slot starts/ends; the
// `wall_start` field carries the venue-local "HH:MM" the operator
// configured the service with — useful for clients that want to
// display the time without a tz library.
//
// Why public + anonymous: the booking widget is anonymous (no auth
// required to discover slots before posting). Authed REST customers
// reach the same data without a Bearer token; this matches Stripe's
// "publicly listable" pattern for shipping rates / public products.
// Closes spec acceptance #2 of bookings.md.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { zIsoDate, zPartySizeParam, zUuid } from "@/lib/api/v1/validation";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { loadPublicAvailability, loadPublicVenue } from "@/lib/public/venue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Query = z.object({
  venue_id: zUuid,
  date: zIsoDate,
  party_size: zPartySizeParam,
});

// Field-specific 400 codes are part of the public contract — preserve
// the original first-failure precedence (venue_id, date, party_size).
const FIELD_ERROR: ReadonlyArray<[field: string, code: string]> = [
  ["venue_id", "invalid-venue-id"],
  ["date", "invalid-date"],
  ["party_size", "invalid-party-size"],
];

export async function GET(req: NextRequest): Promise<Response> {
  // Rate limit by IP. 30/min is generous for a real widget user
  // browsing dates; anything beyond is automation.
  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit(`availability:${ip}`, 30, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec ?? 60) } },
    );
  }

  const url = new URL(req.url);
  const parsed = Query.safeParse({
    venue_id: url.searchParams.get("venue_id"),
    date: url.searchParams.get("date"),
    party_size: url.searchParams.get("party_size"),
  });
  if (!parsed.success) {
    const failed = new Set(parsed.error.issues.map((i) => i.path[0]));
    const [, code] = FIELD_ERROR.find(([field]) => failed.has(field)) ?? [
      "party_size",
      "invalid-party-size",
    ];
    return NextResponse.json({ error: code }, { status: 400 });
  }
  const { venue_id: venueId, date, party_size: partySize } = parsed.data;

  const venue = await loadPublicVenue(venueId);
  if (!venue) {
    return NextResponse.json({ error: "venue-not-found" }, { status: 404 });
  }

  const availability = await loadPublicAvailability(venue, { date, partySize });

  return NextResponse.json(
    {
      venue_id: venueId,
      timezone: venue.timezone,
      date,
      party_size: partySize,
      slots: availability.slots.map((s) => ({
        service_id: s.serviceId,
        service_name: s.serviceName,
        wall_start: s.wallStart,
        start_at: s.startAt.toISOString(),
        end_at: s.endAt.toISOString(),
      })),
    },
    {
      // Slots change as bookings come in; cache for 30s at the edge
      // to absorb a refresh-spamming widget user without going
      // stale enough to mislead them about a now-taken slot.
      headers: { "cache-control": "public, max-age=30, s-maxage=30" },
    },
  );
}
