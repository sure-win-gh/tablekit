"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { createBooking } from "@/lib/bookings/create";
import { BOOKING_STATUSES, type BookingStatus } from "@/lib/bookings/state";
import { transitionBooking } from "@/lib/bookings/transition";
import { upsertGuestInput } from "@/lib/guests/schema";

// Shape of the form post from /bookings/new. The guest fields feed
// straight into lib/guests — no second Zod pass needed.
const CreateBookingForm = z.object({
  venueId: z.string().uuid(),
  serviceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  wallStart: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Use HH:MM"),
  partySize: z.coerce.number().int().min(1).max(20),
  notes: z.string().max(500).optional(),
  guest: upsertGuestInput,
});

export type CreateBookingActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; bookingId: string };

export async function createBookingAction(
  _prev: CreateBookingActionState,
  formData: FormData,
): Promise<CreateBookingActionState> {
  const { userId, orgId } = await requireRole("host");

  // FormData → nested shape. The guest subfields arrive flat.
  const raw = {
    venueId: formData.get("venueId"),
    serviceId: formData.get("serviceId"),
    date: formData.get("date"),
    wallStart: formData.get("wallStart"),
    partySize: formData.get("partySize"),
    notes: formData.get("notes") || undefined,
    guest: {
      firstName: formData.get("firstName"),
      lastName: formData.get("lastName") ?? "",
      email: formData.get("email"),
      phone: formData.get("phone") || undefined,
    },
  };

  const parsed = CreateBookingForm.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

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
    const message = {
      "guest-invalid": `Guest details invalid: ${"issues" in r ? r.issues.join("; ") : ""}`,
      "slot-taken": "Someone else just took that slot — pick another.",
      "no-availability": "That slot is no longer available.",
      "venue-not-found": "Venue not found.",
    }[r.reason];
    return { status: "error", message };
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/bookings`);
  return { status: "created", bookingId: r.bookingId };
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

const TransitionForm = z.object({
  venueId: z.string().uuid(),
  bookingId: z.string().uuid(),
  to: z.enum(BOOKING_STATUSES),
  cancelledReason: z.string().max(200).optional(),
});

export type TransitionActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; from: BookingStatus; to: BookingStatus };

export async function transitionBookingAction(
  _prev: TransitionActionState,
  formData: FormData,
): Promise<TransitionActionState> {
  const { userId, orgId } = await requireRole("host");

  const parsed = TransitionForm.safeParse({
    venueId: formData.get("venueId"),
    bookingId: formData.get("bookingId"),
    to: formData.get("to"),
    cancelledReason: formData.get("cancelledReason") || undefined,
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  const options = parsed.data.cancelledReason
    ? { cancelledReason: parsed.data.cancelledReason }
    : undefined;
  const r = await transitionBooking(orgId, userId, parsed.data.bookingId, parsed.data.to, options);
  if (!r.ok) {
    const message = {
      "not-found": "Booking not found.",
      "invalid-transition": `Cannot move from ${"from" in r ? r.from : ""} to ${"to" in r ? r.to : ""}.`,
    }[r.reason];
    return { status: "error", message };
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/bookings`);
  return { status: "done", from: r.from, to: r.to };
}
