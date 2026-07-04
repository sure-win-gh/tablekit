// Auto-finish sweeps — transition stale "seated" bookings to
// "finished" so forgotten tables don't block availability, rot red on
// the floor plan, or skip the thank-you message. Two entry points:
//
//   sweepVenueStaleSeated — venue-scoped, called from the overdue-poll
//     server action so any open dashboard tidies its own venue in
//     near-real-time. Respects the venue's closing time (+ grace).
//   sweepAllStaleSeated  — global nightly cron backstop for venues
//     with no dashboard open. Coarser rule: end_at < now − 3h.
//
// Both go through transitionBooking(orgId, null actor, id, "finished")
// so booking events, audit ("system" = null actor), the thank-you
// trigger, and the booking.updated webhook fire exactly as a manual
// finish would. Both respect settings.serviceFlow.autoFinishEnabled.
// See docs/specs/service-flow.md.

import "server-only";

import { and, eq, inArray, lt } from "drizzle-orm";

import { dayKeyInZone, zonedWallToUtc, type DayKey } from "@/lib/bookings/time";
import { formatInTimeZone } from "date-fns-tz";
import { bookings, services, venues } from "@/lib/db/schema";
import { parseServiceFlow } from "@/lib/venues/service-flow";
import { adminDb } from "@/lib/server/admin/db";

import { transitionBooking } from "./transition";

// Finishing a table the moment the last service ends would fight the
// operator during a normal late finish; an hour's grace means the
// sweep only ever tidies genuinely forgotten tables.
const CLOSE_GRACE_MINUTES = 60;

// Cron backstop threshold — coarse and timezone-agnostic: any seated
// booking whose booked end passed 3+ hours ago is over.
const CRON_STALE_HOURS = 3;

type Schedule = { days: DayKey[]; start: string; end: string };

// Pure: the venue's closing time (minutes from local midnight) on a
// given weekday — the latest `schedule.end` across services running
// that day. Null when no service runs (closed day / no services).
// Exported for unit tests.
export function venueCloseMinutes(
  serviceRows: Array<{ schedule: unknown }>,
  weekday: DayKey,
): number | null {
  let close: number | null = null;
  for (const s of serviceRows) {
    const sched = s.schedule as Partial<Schedule> | null;
    if (!sched?.end || !Array.isArray(sched.days) || !sched.days.includes(weekday)) continue;
    const [hh = "0", mm = "0"] = sched.end.split(":");
    const min = Number(hh) * 60 + Number(mm);
    if (Number.isFinite(min)) close = close === null ? min : Math.max(close, min);
  }
  return close;
}

export type SweepResult = { finished: number };

// Pure: the instant before which a venue's seated bookings count as
// stale. Always at least the start of the current venue-day (previous
// days are over by definition); once today's close + grace has passed,
// "now" — so today's still-seated tables qualify too. Exported for
// unit tests (tests/unit/finish-sweep-close.test.ts).
export function staleSeatedCutoff(
  now: Date,
  timezone: string,
  serviceRows: Array<{ schedule: unknown }>,
): Date {
  const todayYmd = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const startOfToday = zonedWallToUtc(todayYmd, "00:00", timezone);

  const weekday = dayKeyInZone(now, timezone);
  const close = venueCloseMinutes(serviceRows, weekday);
  if (close === null) return startOfToday;

  const nowMin =
    Number(formatInTimeZone(now, timezone, "H")) * 60 +
    Number(formatInTimeZone(now, timezone, "m"));
  return nowMin >= close + CLOSE_GRACE_MINUTES ? now : startOfToday;
}

// Venue-scoped inline sweep. Finishes seated bookings that are either
// from a previous venue-day, or from today once the venue has closed
// (last service end + grace). Cheap when there's nothing to do: one
// SELECT over the partial venue/start index.
export async function sweepVenueStaleSeated(venueId: string): Promise<SweepResult> {
  const db = adminDb();

  const [venue] = await db
    .select({
      id: venues.id,
      organisationId: venues.organisationId,
      timezone: venues.timezone,
      settings: venues.settings,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  if (!venue) return { finished: 0 };
  if (!parseServiceFlow(venue.settings).autoFinishEnabled) return { finished: 0 };

  const svcRows = await db
    .select({ schedule: services.schedule })
    .from(services)
    .where(eq(services.venueId, venueId));
  // Bookings ending before this instant get finished — see
  // staleSeatedCutoff for the venue-local close + grace rules.
  const cutoff = staleSeatedCutoff(new Date(), venue.timezone, svcRows);

  const stale = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(eq(bookings.venueId, venueId), eq(bookings.status, "seated"), lt(bookings.endAt, cutoff)),
    );

  let finished = 0;
  for (const b of stale) {
    const r = await transitionBooking(venue.organisationId, null, b.id, "finished");
    if (r.ok) finished += 1;
  }
  return { finished };
}

// Global nightly backstop. Coarse rule (end_at < now − 3h) so it needs
// no per-venue timezone maths at 03:15 UTC; per-venue autoFinishEnabled
// still gates each row.
export async function sweepAllStaleSeated(): Promise<SweepResult> {
  const db = adminDb();
  const threshold = new Date(Date.now() - CRON_STALE_HOURS * 60 * 60 * 1000);

  const stale = await db
    .select({ id: bookings.id, organisationId: bookings.organisationId, venueId: bookings.venueId })
    .from(bookings)
    .where(and(eq(bookings.status, "seated"), lt(bookings.endAt, threshold)))
    // Batch cap so a pathological backlog can't run the function past
    // its timeout mid-way through unawaited side-effects; tomorrow's
    // run (or any inline sweep) catches the remainder.
    .limit(200);
  if (stale.length === 0) return { finished: 0 };

  // One settings read per distinct venue, not per booking.
  const venueIds = [...new Set(stale.map((b) => b.venueId))];
  const venueRows = await db
    .select({ id: venues.id, settings: venues.settings })
    .from(venues)
    .where(inArray(venues.id, venueIds));
  const enabledByVenue = new Map(
    venueRows.map((v) => [v.id, parseServiceFlow(v.settings).autoFinishEnabled]),
  );

  let finished = 0;
  for (const b of stale) {
    if (!enabledByVenue.get(b.venueId)) continue;
    const r = await transitionBooking(b.organisationId, null, b.id, "finished");
    if (r.ok) finished += 1;
  }
  return { finished };
}
