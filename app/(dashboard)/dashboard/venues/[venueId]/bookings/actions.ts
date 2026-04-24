"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { createBooking } from "@/lib/bookings/create";
import { BOOKING_STATUSES, type BookingStatus } from "@/lib/bookings/state";
import { transitionBooking } from "@/lib/bookings/transition";
import { upsertGuestInput } from "@/lib/guests/schema";
import { refundBooking } from "@/lib/payments/refunds";

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
      // `deposit-failed` can't fire here — host bookings skip the
      // deposit branch inside createBooking — but the map has to be
      // exhaustive for TS.
      "deposit-failed": "Unexpected payment error — please try again.",
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

// ---------------------------------------------------------------------------
// Refund (full) — operator-initiated. Partial refunds deferred to a
// dedicated UI when there's a real demand; MVP is full-refund only.
// ---------------------------------------------------------------------------

const RefundForm = z.object({
  venueId: z.uuid(),
  bookingId: z.uuid(),
  reason: z.string().min(3, "Reason must be at least 3 characters").max(200),
});

export type RefundActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; refundId: string };

export async function refundBookingAction(
  _prev: RefundActionState,
  formData: FormData,
): Promise<RefundActionState> {
  const { userId, orgId } = await requireRole("manager");

  const parsed = RefundForm.safeParse({
    venueId: formData.get("venueId"),
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the refund form.",
    };
  }

  const r = await refundBooking({
    organisationId: orgId,
    actorUserId: userId,
    bookingId: parsed.data.bookingId,
    reason: parsed.data.reason,
  });
  if (!r.ok) {
    const message = {
      "payments-disabled": "Payments are currently disabled.",
      "no-connect-account": "Stripe isn't connected for this organisation.",
      "no-deposit": "This booking doesn't have a succeeded deposit to refund.",
      "booking-not-in-org": "Booking not found.",
      "stripe-error": r.message ?? "Stripe error — try again in a minute.",
    }[r.reason];
    return { status: "error", message };
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/bookings`);
  return { status: "done", refundId: r.refundId };
}
