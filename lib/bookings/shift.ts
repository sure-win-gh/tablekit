// Shift a booking's start time, preserving its duration.
//
// Updates bookings.start_at + end_at; the sync_booking_tables_on_time_change
// trigger (migration 0004) propagates the change to the booking_tables
// junction. The booking_tables EXCLUDE constraint catches an overlap on
// the same table → mapped here to slot-taken so the host UI can prompt
// for a different time.
//
// MVP scope: same-day, same-table. Cross-day rollovers are rejected
// upstream (the timeline page only renders today's bookings); cross-
// table moves go through reassignBookingTable instead.

import "server-only";

import { and, eq } from "drizzle-orm";

import { bookings } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type ShiftBookingTimeInput = {
  organisationId: string;
  actorUserId: string;
  bookingId: string;
  newStartAt: Date;
};

export type ShiftBookingTimeResult =
  | { ok: true; newStartAt: Date; newEndAt: Date }
  | { ok: false; reason: "not-found" | "slot-taken" | "terminal-status" };

const TERMINAL = new Set(["finished", "cancelled", "no_show"]);

export async function shiftBookingTime(
  input: ShiftBookingTimeInput,
): Promise<ShiftBookingTimeResult> {
  const db = adminDb();

  const [booking] = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
    })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.organisationId, input.organisationId)))
    .limit(1);
  if (!booking) return { ok: false, reason: "not-found" };
  if (TERMINAL.has(booking.status)) return { ok: false, reason: "terminal-status" };

  // Preserve duration. The wall-clock start is the source of truth;
  // the end follows.
  const durationMs = booking.endAt.getTime() - booking.startAt.getTime();
  const newEndAt = new Date(input.newStartAt.getTime() + durationMs);

  try {
    await db
      .update(bookings)
      .set({ startAt: input.newStartAt, endAt: newEndAt })
      .where(
        and(eq(bookings.id, input.bookingId), eq(bookings.organisationId, input.organisationId)),
      );
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
      kind: "time-shift",
      fromStartAt: booking.startAt.toISOString(),
      toStartAt: input.newStartAt.toISOString(),
    },
  });

  return { ok: true, newStartAt: input.newStartAt, newEndAt };
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
