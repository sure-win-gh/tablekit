// Resize a booking — extend or shorten its duration by updating
// only end_at; start_at stays put.
//
// Mirrors lib/bookings/shift.ts: the
// sync_booking_tables_on_time_change trigger (migration 0004)
// propagates the change to the booking_tables junction; the
// EXCLUDE constraint catches an overlap on the same table → mapped
// here to slot-taken.
//
// MVP scope: same-day. The timeline UI clamps the picker so the
// new end can't exceed the visible window (which is bounded by
// services). Cross-day end times need the timeline to render past
// midnight first.

import "server-only";

import { and, eq } from "drizzle-orm";

import { bookings } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type ResizeBookingInput = {
  organisationId: string;
  actorUserId: string;
  bookingId: string;
  newEndAt: Date;
};

export type ResizeBookingResult =
  | { ok: true; newEndAt: Date }
  | { ok: false; reason: "not-found" | "slot-taken" | "terminal-status" | "non-positive-duration" };

const TERMINAL = new Set(["finished", "cancelled", "no_show"]);

export async function resizeBookingDuration(
  input: ResizeBookingInput,
): Promise<ResizeBookingResult> {
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
  if (input.newEndAt.getTime() <= booking.startAt.getTime()) {
    return { ok: false, reason: "non-positive-duration" };
  }

  try {
    await db
      .update(bookings)
      .set({ endAt: input.newEndAt })
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
      kind: "duration-resize",
      fromEndAt: booking.endAt.toISOString(),
      toEndAt: input.newEndAt.toISOString(),
    },
  });

  return { ok: true, newEndAt: input.newEndAt };
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
