// Move a booking from one table to another within the same area.
//
// The enforce_booking_tables_denorm trigger requires the new table's
// area to match the booking's area, so cross-area moves are rejected
// at the DB level. The booking_tables EXCLUDE constraint catches a
// move into an already-occupied slot — mapped here to slot-taken so
// the host UI can prompt for a different table.
//
// MVP scope: single-table → single-table swap. Multi-table bookings
// (combined tables) need a richer "split / merge" UI we'll defer
// until operators ask.

import "server-only";

import { and, eq } from "drizzle-orm";

import { bookingTables, bookings, venueTables } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type ReassignBookingTableInput = {
  organisationId: string;
  actorUserId: string;
  bookingId: string;
  fromTableId: string;
  toTableId: string;
};

export type ReassignBookingTableResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "wrong-area" | "slot-taken" };

export async function reassignBookingTable(
  input: ReassignBookingTableInput,
): Promise<ReassignBookingTableResult> {
  const db = adminDb();

  const [booking] = await db
    .select({ id: bookings.id, areaId: bookings.areaId })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.organisationId, input.organisationId)))
    .limit(1);
  if (!booking) return { ok: false, reason: "not-found" };

  const [target] = await db
    .select({ id: venueTables.id, areaId: venueTables.areaId })
    .from(venueTables)
    .where(
      and(
        eq(venueTables.id, input.toTableId),
        eq(venueTables.organisationId, input.organisationId),
      ),
    )
    .limit(1);
  if (!target) return { ok: false, reason: "not-found" };
  if (target.areaId !== booking.areaId) return { ok: false, reason: "wrong-area" };

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(bookingTables)
        .where(
          and(
            eq(bookingTables.bookingId, input.bookingId),
            eq(bookingTables.tableId, input.fromTableId),
          ),
        );
      await tx.insert(bookingTables).values({
        bookingId: input.bookingId,
        tableId: input.toTableId,
        // Overwritten by the enforce_booking_tables_denorm trigger.
        organisationId: input.organisationId,
        venueId: "00000000-0000-0000-0000-000000000000",
        areaId: booking.areaId,
        startAt: new Date(0),
        endAt: new Date(0),
      });
    });
  } catch (err: unknown) {
    if (isExclusionViolation(err)) return { ok: false, reason: "slot-taken" };
    throw err;
  }

  await audit.log({
    organisationId: input.organisationId,
    actorUserId: input.actorUserId,
    action: "booking.transitioned",
    targetType: "booking",
    targetId: input.bookingId,
    metadata: {
      kind: "table-reassign",
      fromTableId: input.fromTableId,
      toTableId: input.toTableId,
    },
  });

  return { ok: true };
}

function isExclusionViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const direct = (err as { code?: unknown }).code;
  if (direct === "23P01") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23P01") {
    return true;
  }
  return false;
}
