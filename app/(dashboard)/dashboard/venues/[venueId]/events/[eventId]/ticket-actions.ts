"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { eventTicketTypes, specialEvents } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { stripeEnabled } from "@/lib/stripe/client";

import type { ActionState } from "../types";

// Confirm the event is in the caller's org before touching its ticket types.
async function assertEventInOrg(eventId: string, orgId: string): Promise<void> {
  const [row] = await adminDb()
    .select({ id: specialEvents.id })
    .from(specialEvents)
    .where(and(eq(specialEvents.id, eventId), eq(specialEvents.organisationId, orgId)))
    .limit(1);
  if (!row) throw new Error("event not found or not in your organisation");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const CreateBody = z.object({
  eventId: z.uuid(),
  venueId: z.uuid(),
  name: z.string().trim().min(1, "Give the ticket a name").max(60),
  // Pounds entered in the form; a synced hidden input posts pence.
  priceMinor: z.coerce.number().int().min(1, "Price must be at least 1p").max(1_000_000), // £10,000
  quantityTotal: z.coerce.number().int().min(1, "Capacity must be at least 1").max(100_000),
  maxPerOrder: z.coerce.number().int().min(1).max(100).default(10),
});

export async function createTicketType(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = CreateBody.safeParse({
    eventId: formData.get("event_id"),
    venueId: formData.get("venue_id"),
    name: formData.get("name"),
    priceMinor: formData.get("price_minor"),
    quantityTotal: formData.get("quantity_total"),
    maxPerOrder: formData.get("max_per_order") || "10",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the fields." };
  }

  // Ticket sales need Stripe live (spec: creation is blocked with
  // Stripe off, so an operator can't build a checkout that can't take
  // payment).
  if (!stripeEnabled()) {
    return { status: "error", message: "Payments are currently unavailable — try again later." };
  }

  const { orgId, userId } = await requireRole("manager");
  await requirePlan(orgId, "plus");
  await assertEventInOrg(parsed.data.eventId, orgId);

  const [inserted] = await adminDb()
    .insert(eventTicketTypes)
    .values({
      organisationId: orgId,
      eventId: parsed.data.eventId,
      name: parsed.data.name,
      priceMinor: parsed.data.priceMinor,
      quantityTotal: parsed.data.quantityTotal,
      maxPerOrder: parsed.data.maxPerOrder,
    })
    .returning({ id: eventTicketTypes.id });

  if (inserted) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "event_ticket_type.created",
      targetType: "event_ticket_type",
      targetId: inserted.id,
      metadata: {
        eventId: parsed.data.eventId,
        priceMinor: parsed.data.priceMinor,
        quantityTotal: parsed.data.quantityTotal,
      },
    });
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/events/${parsed.data.eventId}`);
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const DeleteBody = z.object({
  ticketTypeId: z.uuid(),
  eventId: z.uuid(),
  venueId: z.uuid(),
});

export async function deleteTicketType(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = DeleteBody.safeParse({
    ticketTypeId: formData.get("ticket_type_id"),
    eventId: formData.get("event_id"),
    venueId: formData.get("venue_id"),
  });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId, userId } = await requireRole("manager");
  await requirePlan(orgId, "plus");

  let deleted: { id: string }[];
  try {
    deleted = await adminDb()
      .delete(eventTicketTypes)
      .where(
        and(
          eq(eventTicketTypes.id, parsed.data.ticketTypeId),
          eq(eventTicketTypes.organisationId, orgId),
        ),
      )
      .returning({ id: eventTicketTypes.id });
  } catch (err) {
    // 23503 — this tier has sales (event_order_items reference it). Sold
    // tiers stay for the record; you cancel + refund, not delete.
    const code = (err as { code?: unknown }).code;
    const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
    if (code === "23503" || causeCode === "23503") {
      return { status: "error", message: "This ticket type has sales and can't be deleted." };
    }
    throw err;
  }

  if (deleted.length > 0) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "event_ticket_type.deleted",
      targetType: "event_ticket_type",
      targetId: parsed.data.ticketTypeId,
      metadata: { eventId: parsed.data.eventId },
    });
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/events/${parsed.data.eventId}`);
  return { status: "saved" };
}
