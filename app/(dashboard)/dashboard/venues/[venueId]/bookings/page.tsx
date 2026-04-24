import { and, asc, eq, gte, lt } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import {
  formatVenueDateLong,
  formatVenueTime,
  todayInZone,
  venueLocalDayRange,
} from "@/lib/bookings/time";
import { nextActions, type BookingStatus } from "@/lib/bookings/state";
import { withUser } from "@/lib/db/client";
import { bookings, guests, services, venues } from "@/lib/db/schema";

import { BookingRow } from "./forms";

// Per-day bookings list. Defaults to today in the venue's timezone.
// `?date=YYYY-MM-DD` overrides — used by the future calendar UI and
// for deep-linking from the new-booking success screen.

export const metadata = { title: "Bookings · TableKit" };

type SearchParams = { date?: string };

export default async function BookingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireRole("host");
  const { venueId } = await params;
  const { date: dateParam } = await searchParams;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, timezone: venues.timezone, locale: venues.locale })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const date = dateParam ?? todayInZone(venue.timezone);
  const { startUtc, endUtc } = venueLocalDayRange(date, venue.timezone);

  const rows = await withUser(async (db) => {
    return db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        partySize: bookings.partySize,
        status: bookings.status,
        notes: bookings.notes,
        serviceName: services.name,
        guestFirstName: guests.firstName,
      })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .innerJoin(guests, eq(guests.id, bookings.guestId))
      .where(
        and(
          eq(bookings.venueId, venueId),
          gte(bookings.startAt, startUtc),
          lt(bookings.startAt, endUtc),
        ),
      )
      .orderBy(asc(bookings.startAt));
  });

  // Group by service for the day view (lunch / dinner etc.). Empty
  // groups are hidden.
  const byService = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byService.get(r.serviceName) ?? [];
    list.push(r);
    byService.set(r.serviceName, list);
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-medium">
            {formatVenueDateLong(startUtc, { timezone: venue.timezone })}
          </h2>
          <p className="text-xs text-neutral-500">
            {rows.length === 0 ? "No bookings yet." : `${rows.length} booking${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link
          href={`/dashboard/venues/${venueId}/bookings/new`}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800"
        >
          + New booking
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
          Nothing on the books for this day. Click &ldquo;New booking&rdquo; to add one.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {[...byService.entries()].map(([svc, list]) => (
            <div key={svc}>
              <h3 className="text-sm font-semibold tracking-tight text-neutral-700">{svc}</h3>
              <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
                {list.map((b) => (
                  <BookingRow
                    key={b.id}
                    venueId={venueId}
                    bookingId={b.id}
                    wallStart={formatVenueTime(b.startAt, { timezone: venue.timezone })}
                    wallEnd={formatVenueTime(b.endAt, { timezone: venue.timezone })}
                    partySize={b.partySize}
                    status={b.status as BookingStatus}
                    actions={nextActions(b.status as BookingStatus)}
                    guestFirstName={b.guestFirstName}
                    notes={b.notes}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

