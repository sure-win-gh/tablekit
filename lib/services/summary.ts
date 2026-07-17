// Per-day service summary — for a chosen venue-local date, one row per
// service scheduled that day: capacity (room or override), booked covers,
// utilisation, open slots, and the service window.
//
// Booked covers come straight from each booking's serviceId (no window
// join needed — a booking already carries the service it belongs to).
// Open slots reuse the pure availability engine, assembled exactly as the
// public availability path does (lib/public/venue.ts).

import "server-only";

import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  findSlots,
  type Occupancy,
  type ServiceSpec,
  type Slot,
  type TableSpec,
} from "@/lib/bookings/availability";
import { loadVenueCombining } from "@/lib/bookings/combinable";
import { dayKeyInZone, venueLocalDayRange, zonedWallToUtc, type DayKey } from "@/lib/bookings/time";
import { bookings, bookingTables, services, venueTables } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import { getRoomCapacity, getServiceCapacityOverrides, resolveCapacity } from "./capacity";

type Db = NodePgDatabase<typeof schema>;

type Schedule = { days: DayKey[]; start: string; end: string };

export type ServiceSummaryRow = {
  serviceId: string;
  serviceName: string;
  capacity: number;
  bookedCovers: number;
  bookingsCount: number;
  utilisation: number; // 0..1; 0 when capacity is 0
  openSlots: number;
  turnMinutes: number;
  windowStart: Date; // UTC
  windowEnd: Date; // UTC
};

const REPRESENTATIVE_PARTY = 2;

// Day-prep aggregates for the KPI band — counts only, computed in SQL.
// dietaryNotesCount counts bookings whose (encrypted) dietary note is
// present; the ciphertext itself is never read, let alone decrypted.
export type DayPrep = {
  highChairs: number;
  dietaryNotesCount: number;
  largestParty: number;
};

export async function getDayPrep(
  db: Db,
  venueId: string,
  date: string,
  timezone: string,
): Promise<DayPrep> {
  const { startUtc, endUtc } = venueLocalDayRange(date, timezone);
  const [row] = await db
    .select({
      highChairs: sql<number>`coalesce(sum(${bookings.highChairs}), 0)::int`.as("highChairs"),
      dietaryNotesCount:
        sql<number>`count(*) filter (where ${bookings.dietaryNotesCipher} is not null)::int`.as(
          "dietaryNotesCount",
        ),
      largestParty: sql<number>`coalesce(max(${bookings.partySize}), 0)::int`.as("largestParty"),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, startUtc),
        lt(bookings.startAt, endUtc),
        ne(bookings.status, "cancelled"),
      ),
    );
  return row ?? { highChairs: 0, dietaryNotesCount: 0, largestParty: 0 };
}

export async function getServiceSummary(
  db: Db,
  venueId: string,
  date: string,
  timezone: string,
): Promise<ServiceSummaryRow[]> {
  // Day-of-week the date falls on in the venue's zone (noon avoids any
  // DST-boundary ambiguity at midnight).
  const weekday = dayKeyInZone(zonedWallToUtc(date, "12:00", timezone), timezone);
  const { startUtc, endUtc } = venueLocalDayRange(date, timezone);

  const [serviceRows, tableRows, bookedRows, occupied] = await Promise.all([
    db
      .select({
        id: services.id,
        name: services.name,
        schedule: services.schedule,
        turnMinutes: services.turnMinutes,
      })
      .from(services)
      .where(eq(services.venueId, venueId)),
    db
      .select({
        id: venueTables.id,
        areaId: venueTables.areaId,
        minCover: venueTables.minCover,
        maxCover: venueTables.maxCover,
      })
      .from(venueTables)
      .where(eq(venueTables.venueId, venueId)),
    db
      .select({
        serviceId: bookings.serviceId,
        bookedCovers: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("bookedCovers"),
        bookingsCount: sql<number>`count(*)::int`.as("bookingsCount"),
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.venueId, venueId),
          gte(bookings.startAt, startUtc),
          lt(bookings.startAt, endUtc),
          ne(bookings.status, "cancelled"),
        ),
      )
      .groupBy(bookings.serviceId),
    db
      .select({
        tableId: bookingTables.tableId,
        startAt: bookingTables.startAt,
        endAt: bookingTables.endAt,
      })
      .from(bookingTables)
      .where(
        and(
          eq(bookingTables.venueId, venueId),
          gte(bookingTables.startAt, startUtc),
          lt(bookingTables.startAt, endUtc),
        ),
      ),
  ]);

  const roomCapacity = await getRoomCapacity(db, venueId);
  const overrides = await getServiceCapacityOverrides(db, venueId);

  const bookedByService = new Map(bookedRows.map((r) => [r.serviceId, r]));

  // Open slots from the pure availability engine, assembled as in
  // lib/public/venue.ts. It only emits slots for services scheduled today.
  const serviceSpecs: ServiceSpec[] = serviceRows.map((s) => ({
    id: s.id,
    name: s.name,
    schedule: s.schedule as Schedule,
    turnMinutes: s.turnMinutes,
  }));
  const tableSpecs: TableSpec[] = tableRows;
  const { combinable, maxCombineTables } = await loadVenueCombining(db, venueId);
  const slots: Slot[] = findSlots({
    timezone,
    date,
    partySize: REPRESENTATIVE_PARTY,
    services: serviceSpecs,
    tables: tableSpecs,
    occupied: occupied as Occupancy[],
    combinable,
    maxCombineTables,
  });
  const openByService = new Map<string, number>();
  for (const slot of slots) {
    openByService.set(slot.serviceId, (openByService.get(slot.serviceId) ?? 0) + 1);
  }

  // One row per service whose schedule includes this weekday.
  return serviceRows
    .filter((s) => (s.schedule as Schedule).days.includes(weekday))
    .map((s) => {
      const sched = s.schedule as Schedule;
      const capacity = resolveCapacity(roomCapacity, overrides.get(s.id));
      const booked = bookedByService.get(s.id);
      const bookedCovers = booked?.bookedCovers ?? 0;
      return {
        serviceId: s.id,
        serviceName: s.name,
        capacity,
        bookedCovers,
        bookingsCount: booked?.bookingsCount ?? 0,
        utilisation: capacity === 0 ? 0 : bookedCovers / capacity,
        openSlots: openByService.get(s.id) ?? 0,
        turnMinutes: s.turnMinutes,
        windowStart: zonedWallToUtc(date, sched.start, timezone),
        windowEnd: zonedWallToUtc(date, sched.end, timezone),
      };
    })
    .sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
}
