"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { reassignBookingTable } from "@/lib/bookings/reassign";

// Drag-handler-friendly shape of reassignTableAction. The bookings
// page's existing action consumes FormData (works with <form>); the
// timeline drag flow doesn't have a form to bind, so we expose a
// plain-args variant. Same domain helper underneath.

const Args = z.object({
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
  const parsed = Args.safeParse(raw);
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
