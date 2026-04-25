// Public venue-info reads for the widget flow.
//
// Uses `adminDb` to bypass RLS because the `authenticated`-role
// policies don't cover anonymous traffic by design. The trade-off is
// that this file must be careful about what it returns — anything
// that isn't meant to be public-visible must be projected out here.

import "server-only";

import { and, eq, gte, lt } from "drizzle-orm";

import { bookingTables, services, venueTables, venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import {
  findSlots,
  type ServiceSpec,
  type Slot,
  type TableSpec,
} from "@/lib/bookings/availability";
import { venueLocalDayRange } from "@/lib/bookings/time";

export type PublicVenue = {
  id: string;
  name: string;
  timezone: string;
  locale: string;
};

export async function loadPublicVenue(venueId: string): Promise<PublicVenue | null> {
  const db = adminDb();
  const [row] = await db
    .select({
      id: venues.id,
      name: venues.name,
      timezone: venues.timezone,
      locale: venues.locale,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return row ?? null;
}

export type PublicAvailabilityInput = {
  venueId: string;
  date: string; // YYYY-MM-DD, venue-local
  partySize: number;
};

export type PublicAvailability = {
  slots: Array<{
    serviceId: string;
    serviceName: string;
    wallStart: string;
    startAt: Date;
    endAt: Date;
  }>;
};

export async function loadPublicAvailability(
  venue: PublicVenue,
  input: { date: string; partySize: number },
): Promise<PublicAvailability> {
  const db = adminDb();

  const [serviceRows, tableRows] = await Promise.all([
    db
      .select({
        id: services.id,
        name: services.name,
        schedule: services.schedule,
        turnMinutes: services.turnMinutes,
      })
      .from(services)
      .where(eq(services.venueId, venue.id)),
    db
      .select({
        id: venueTables.id,
        areaId: venueTables.areaId,
        minCover: venueTables.minCover,
        maxCover: venueTables.maxCover,
      })
      .from(venueTables)
      .where(eq(venueTables.venueId, venue.id)),
  ]);

  const { startUtc, endUtc } = venueLocalDayRange(input.date, venue.timezone);
  const occupied = await db
    .select({
      tableId: bookingTables.tableId,
      startAt: bookingTables.startAt,
      endAt: bookingTables.endAt,
    })
    .from(bookingTables)
    .where(
      and(
        eq(bookingTables.venueId, venue.id),
        gte(bookingTables.startAt, startUtc),
        lt(bookingTables.startAt, endUtc),
      ),
    );

  const serviceSpecs: ServiceSpec[] = serviceRows.map((s) => ({
    id: s.id,
    name: s.name,
    schedule: s.schedule as ServiceSpec["schedule"],
    turnMinutes: s.turnMinutes,
  }));
  const tableSpecs: TableSpec[] = tableRows;

  const slots: Slot[] = findSlots({
    timezone: venue.timezone,
    date: input.date,
    partySize: input.partySize,
    services: serviceSpecs,
    tables: tableSpecs,
    occupied,
  });

  return {
    slots: slots.map((s) => ({
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      wallStart: s.wallStart,
      startAt: s.startAt,
      endAt: s.endAt,
    })),
  };
}

// Resolve the organisation that owns a venue — needed by the API
// route to scope `createBooking` correctly. Kept separate from
// `loadPublicVenue` so the organisationId doesn't accidentally leak
// into a public response payload.
export async function resolveVenueOrg(venueId: string): Promise<string | null> {
  const db = adminDb();
  const [row] = await db
    .select({ organisationId: venues.organisationId })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return row?.organisationId ?? null;
}
