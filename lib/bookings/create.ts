// Server-callable booking creation.
//
// `createBooking` is the only write path in this phase. It upserts the
// guest, validates the slot against live availability, inserts the
// booking + its table assignments, and emits `booking.created` to
// audit_log + booking_events.
//
// Kept out of the server-actions file so the availability engine +
// domain invariants stay unit-testable without Next's server-action
// wiring and so the widget phase can call the same function from its
// API route.

import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { upsertGuest } from "@/lib/guests/upsert";
import { type UpsertGuestRawInput } from "@/lib/guests/schema";
import {
  bookingEvents,
  bookingTables,
  bookings,
  services,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { findSlots, type TableOption } from "./availability";
import { venueLocalDayRange } from "./time";

export type BookingSource = "host" | "widget" | "rwg" | "api";

export type CreateBookingInput = {
  venueId: string;
  serviceId: string;
  date: string; // YYYY-MM-DD venue-local
  wallStart: string; // "HH:MM" venue-local
  partySize: number;
  guest: UpsertGuestRawInput;
  notes?: string;
  source: BookingSource;
};

export type CreateBookingResult =
  | {
      ok: true;
      bookingId: string;
      guestId: string;
      guestReused: boolean;
      tableIds: string[];
    }
  | { ok: false; reason: "guest-invalid"; issues: string[] }
  | { ok: false; reason: "slot-taken" }
  | { ok: false; reason: "no-availability" }
  | { ok: false; reason: "venue-not-found" };

export async function createBooking(
  organisationId: string,
  actorUserId: string | null,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const db = adminDb();

  // 1. Upsert the guest (validates the guest payload via Zod inside).
  const guestR = await upsertGuest(organisationId, actorUserId, input.guest);
  if (!guestR.ok) {
    return { ok: false, reason: "guest-invalid", issues: guestR.issues };
  }

  // 2. Load venue + services + tables + occupancy for the day.
  const [venue] = await db
    .select({
      id: venues.id,
      timezone: venues.timezone,
      organisationId: venues.organisationId,
    })
    .from(venues)
    .where(and(eq(venues.id, input.venueId), eq(venues.organisationId, organisationId)))
    .limit(1);
  if (!venue) return { ok: false, reason: "venue-not-found" };

  const venueServices = await db
    .select({
      id: services.id,
      name: services.name,
      schedule: services.schedule,
      turnMinutes: services.turnMinutes,
    })
    .from(services)
    .where(eq(services.venueId, venue.id));

  const venueTablesRows = await db
    .select({
      id: venueTables.id,
      areaId: venueTables.areaId,
      minCover: venueTables.minCover,
      maxCover: venueTables.maxCover,
    })
    .from(venueTables)
    .where(eq(venueTables.venueId, venue.id));

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

  // 3. Run availability. Must have at least one matching slot.
  const slots = findSlots({
    timezone: venue.timezone,
    date: input.date,
    partySize: input.partySize,
    services: venueServices.map((s) => ({
      id: s.id,
      name: s.name,
      schedule: s.schedule as { days: never; start: string; end: string },
      turnMinutes: s.turnMinutes,
    })),
    tables: venueTablesRows,
    occupied,
  });

  const slot = slots.find(
    (s) => s.serviceId === input.serviceId && s.wallStart === input.wallStart,
  );
  if (!slot) return { ok: false, reason: "no-availability" };

  // Pick the first option (smallest-sufficient). The UI can refine
  // later by letting the host choose, but for now "first fit" is fine.
  const option: TableOption | undefined = slot.options[0];
  if (!option) return { ok: false, reason: "no-availability" };

  // 4. Insert the booking + its table assignments in one transaction.
  //    The EXCLUDE constraint on booking_tables catches any concurrent
  //    booker who got there first — caught and mapped to slot-taken.
  try {
    const bookingId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(bookings)
        .values({
          // org/venue are denormalised by the enforce_bookings trigger
          // from service_id + area_id. We pass the ids we know but the
          // trigger is the source of truth.
          organisationId,
          venueId: venue.id,
          serviceId: input.serviceId,
          areaId: option.areaId,
          guestId: guestR.guestId,
          partySize: input.partySize,
          startAt: slot.startAt,
          endAt: slot.endAt,
          status: "confirmed",
          source: input.source,
          notes: input.notes ?? null,
          bookedByUserId: actorUserId,
        })
        .returning({ id: bookings.id });
      if (!inserted) throw new Error("createBooking: insert returned no row");

      // Insert the junction rows. The exclusion constraint fires here.
      await tx.insert(bookingTables).values(
        option.tableIds.map((tableId) => ({
          bookingId: inserted.id,
          tableId,
          // These four are overwritten by the enforce_booking_tables
          // trigger from the parent booking; pass zeroes just to
          // satisfy Drizzle's NOT NULL type checks.
          organisationId,
          venueId: venue.id,
          areaId: option.areaId,
          startAt: slot.startAt,
          endAt: slot.endAt,
        })),
      );

      await tx.insert(bookingEvents).values({
        // organisation_id is overwritten by the enforce trigger.
        organisationId,
        bookingId: inserted.id,
        type: "status.confirmed",
        actorUserId,
        meta: sql`${JSON.stringify({ tableIds: option.tableIds })}::jsonb`,
      });

      return inserted.id;
    });

    await audit.log({
      organisationId,
      actorUserId,
      action: "booking.created",
      targetType: "booking",
      targetId: bookingId,
      metadata: { tableIds: option.tableIds, partySize: input.partySize },
    });

    return {
      ok: true,
      bookingId,
      guestId: guestR.guestId,
      guestReused: guestR.reused,
      tableIds: option.tableIds,
    };
  } catch (err: unknown) {
    // 23P01: exclusion_violation — another booking claimed this slot.
    if (isExclusionViolation(err)) {
      return { ok: false, reason: "slot-taken" };
    }
    throw err;
  }
}

function isExclusionViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "23P01";
}
