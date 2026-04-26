"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { createBooking } from "@/lib/bookings/create";
import { reassignBookingTable } from "@/lib/bookings/reassign";
import { upsertGuestInput } from "@/lib/guests/schema";

// ---------------------------------------------------------------------------
// Reassign — drag-and-drop reassignment.
//
// The bookings page's existing action consumes FormData (works with
// <form>); the timeline drag flow doesn't have a form to bind, so
// we expose a plain-args variant. Same domain helper underneath.
// ---------------------------------------------------------------------------

const ReassignArgs = z.object({
  venueId: z.uuid(),
  bookingId: z.uuid(),
  fromTableId: z.uuid(),
  toTableId: z.uuid(),
});

export type ReassignFromTimelineState =
  | { ok: true }
  | { ok: false; reason: "invalid" | "not-found" | "wrong-area" | "slot-taken" };

export async function reassignFromTimeline(
  raw: unknown,
): Promise<ReassignFromTimelineState> {
  const parsed = ReassignArgs.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.fromTableId === parsed.data.toTableId) return { ok: true };

  const { orgId, userId } = await requireRole("host");
  const r = await reassignBookingTable({
    organisationId: orgId,
    actorUserId: userId,
    bookingId: parsed.data.bookingId,
    fromTableId: parsed.data.fromTableId,
    toTableId: parsed.data.toTableId,
  });

  if (!r.ok) return { ok: false, reason: r.reason };

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/timeline`);
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/bookings`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Create from timeline — drag-to-create modal submit.
//
// Calls createBooking (same path as the host /bookings/new flow,
// source: "host"). createBooking auto-picks an available table from
// availability — if the picked table differs from the operator's
// drag target, we follow up with reassignBookingTable to land where
// they expected. The reassign is best-effort: if it fails (slot
// taken, wrong area), we return ok with a `landedOn` payload so the
// modal can surface a "booked on Table X instead" message.
// ---------------------------------------------------------------------------

const CreateArgs = z.object({
  venueId: z.uuid(),
  serviceId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wallStart: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  partySize: z.number().int().min(1).max(20),
  preferredTableId: z.uuid(),
  notes: z.string().max(500).optional(),
  guest: upsertGuestInput,
});

export type CreateFromTimelineState =
  | { ok: true; bookingId: string; landedOn: "preferred" | "elsewhere" }
  | {
      ok: false;
      reason: "invalid-input" | "slot-taken" | "no-availability" | "venue-not-found" | "guest-invalid" | "deposit-failed";
      message?: string | undefined;
    };

export async function createFromTimeline(raw: unknown): Promise<CreateFromTimelineState> {
  const parsed = CreateArgs.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid-input",
      message: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }

  const { orgId, userId } = await requireRole("host");

  const r = await createBooking(orgId, userId, {
    venueId: parsed.data.venueId,
    serviceId: parsed.data.serviceId,
    date: parsed.data.date,
    wallStart: parsed.data.wallStart,
    partySize: parsed.data.partySize,
    guest: parsed.data.guest,
    source: "host",
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
  });

  if (!r.ok) {
    if (r.reason === "guest-invalid") {
      return {
        ok: false,
        reason: "guest-invalid",
        message: "issues" in r ? r.issues.join("; ") : undefined,
      };
    }
    return { ok: false, reason: r.reason };
  }

  // Try to land on the drag-targeted table if availability put the
  // booking elsewhere. Only single-table moves; multi-table combos
  // (combined tables) stay where availability picked them.
  let landedOn: "preferred" | "elsewhere" = "preferred";
  if (r.tableIds.length === 1 && r.tableIds[0] !== parsed.data.preferredTableId) {
    const reassign = await reassignBookingTable({
      organisationId: orgId,
      actorUserId: userId,
      bookingId: r.bookingId,
      fromTableId: r.tableIds[0]!,
      toTableId: parsed.data.preferredTableId,
    });
    landedOn = reassign.ok ? "preferred" : "elsewhere";
  } else if (r.tableIds.length > 1) {
    landedOn = "elsewhere";
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/timeline`);
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/bookings`);
  return { ok: true, bookingId: r.bookingId, landedOn };
}
