"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { addWaitlist, addWaitlistInput } from "@/lib/waitlist/add";
import { cancelWaitlist } from "@/lib/waitlist/cancel";
import { seatWaitlist } from "@/lib/waitlist/seat";

import type { ActionState } from "./types";

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

const AddForm = addWaitlistInput; // re-use the domain schema verbatim

export async function addWaitlistAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = AddForm.safeParse({
    venueId: formData.get("venue_id"),
    partySize: Number(formData.get("party_size") ?? 0),
    firstName: formData.get("first_name"),
    phone: formData.get("phone"),
    email: formData.get("email") || undefined,
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the form fields.",
    };
  }

  const { orgId, userId } = await requireRole("host");
  const r = await addWaitlist(orgId, userId, parsed.data);
  if (!r.ok) {
    return { status: "error", message: r.issues.join("; ") };
  }
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/waitlist`);
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Seat
// ---------------------------------------------------------------------------

const SeatForm = z.object({
  venueId: z.uuid(),
  waitlistId: z.uuid(),
  tableId: z.uuid(),
});

export async function seatWaitlistAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = SeatForm.safeParse({
    venueId: formData.get("venue_id"),
    waitlistId: formData.get("waitlist_id"),
    tableId: formData.get("table_id"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Pick a table to seat them at." };
  }

  const { orgId, userId } = await requireRole("host");
  const r = await seatWaitlist(orgId, userId, {
    waitlistId: parsed.data.waitlistId,
    tableId: parsed.data.tableId,
  });
  if (!r.ok) {
    const message = {
      "not-found": "Waitlist entry not found.",
      "wrong-status": "That entry is no longer waiting.",
      "no-service": "Set up at least one service for this venue first.",
      "table-not-in-venue": "That table isn't part of this venue.",
      "slot-taken": "That table is already taken — pick another.",
    }[r.reason];
    return { status: "error", message };
  }
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/waitlist`);
  return { status: "seated", bookingId: r.bookingId };
}

// ---------------------------------------------------------------------------
// Cancel / left
// ---------------------------------------------------------------------------

const CancelForm = z.object({
  venueId: z.uuid(),
  waitlistId: z.uuid(),
  outcome: z.enum(["cancelled", "left"]).default("cancelled"),
});

export async function cancelWaitlistAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = CancelForm.safeParse({
    venueId: formData.get("venue_id"),
    waitlistId: formData.get("waitlist_id"),
    outcome: formData.get("outcome") || "cancelled",
  });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId, userId } = await requireRole("host");
  const r = await cancelWaitlist(orgId, userId, parsed.data.waitlistId, parsed.data.outcome);
  if (!r.ok) {
    return {
      status: "error",
      message: r.reason === "not-found" ? "Entry not found." : "Already closed.",
    };
  }
  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/waitlist`);
  return { status: "saved" };
}
