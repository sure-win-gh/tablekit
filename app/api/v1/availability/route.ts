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

import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { loadPublicAvailability, loadPublicVenue } from "@/lib/public/venue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const venueId = url.searchParams.get("venue_id");
  const date = url.searchParams.get("date");
  const partySizeRaw = url.searchParams.get("party_size");

  if (!venueId || !UUID_RE.test(venueId)) {
    return NextResponse.json({ error: "invalid-venue-id" }, { status: 400 });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "invalid-date" }, { status: 400 });
  }
  const partySize = partySizeRaw ? Number.parseInt(partySizeRaw, 10) : NaN;
  if (!Number.isFinite(partySize) || partySize < 1 || partySize > 20) {
    return NextResponse.json({ error: "invalid-party-size" }, { status: 400 });
  }

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
