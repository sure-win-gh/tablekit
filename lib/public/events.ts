// Public read for a single published special event (the /events landing
// page). Uses `adminDb` to bypass RLS for anonymous traffic — same posture
// as the rest of lib/public/*, so this file must project out anything that
// isn't meant to be public. Only `published` events are ever returned.
//
// See docs/specs/special-events.md.

import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { areas, eventTicketTypes, specialEventAreas, specialEvents } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { getAccount } from "@/lib/stripe/connect";
import { paymentsDisabled, stripeEnabled } from "@/lib/stripe/client";

export type PublicEvent = {
  id: string;
  name: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  blockScope: string;
  externalTicketUrl: string | null;
};

export async function loadPublicEvent(venueId: string, slug: string): Promise<PublicEvent | null> {
  const [row] = await adminDb()
    .select({
      id: specialEvents.id,
      name: specialEvents.name,
      description: specialEvents.description,
      startsAt: specialEvents.startsAt,
      endsAt: specialEvents.endsAt,
      blockScope: specialEvents.blockScope,
      externalTicketUrl: specialEvents.externalTicketUrl,
    })
    .from(specialEvents)
    .where(
      and(
        eq(specialEvents.venueId, venueId),
        eq(specialEvents.slug, slug),
        eq(specialEvents.status, "published"),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Names of the areas an event is scoped to (empty = whole venue). Shown on
// the public event page so guests know where in the venue the event lives.
export async function loadPublicEventAreaNames(eventId: string): Promise<string[]> {
  const rows = await adminDb()
    .select({ name: areas.name })
    .from(specialEventAreas)
    .innerJoin(areas, eq(areas.id, specialEventAreas.areaId))
    .where(eq(specialEventAreas.eventId, eventId))
    .orderBy(asc(areas.sort), asc(areas.name));
  return rows.map((r) => r.name);
}

export type PublicTicketType = {
  id: string;
  name: string;
  priceMinor: number;
  maxPerOrder: number;
  remaining: number;
};

// Ticket tiers for an event, with remaining capacity. Callers only render
// these for a published event (loadPublicEvent already gates on that).
export async function loadPublicEventTicketTypes(eventId: string): Promise<PublicTicketType[]> {
  const rows = await adminDb()
    .select({
      id: eventTicketTypes.id,
      name: eventTicketTypes.name,
      priceMinor: eventTicketTypes.priceMinor,
      maxPerOrder: eventTicketTypes.maxPerOrder,
      quantityTotal: eventTicketTypes.quantityTotal,
      quantitySold: eventTicketTypes.quantitySold,
    })
    .from(eventTicketTypes)
    .where(eq(eventTicketTypes.eventId, eventId))
    .orderBy(asc(eventTicketTypes.sort), asc(eventTicketTypes.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    priceMinor: r.priceMinor,
    maxPerOrder: r.maxPerOrder,
    remaining: Math.max(0, r.quantityTotal - r.quantitySold),
  }));
}

// Whether the native checkout can actually take a payment for this
// event's org — Stripe live, connected account able to charge, and the
// org still on a plan with the events feature. Server-only derivation
// so organisationId never enters the public DTOs. The page uses this
// to fall back to link-out / "contact the venue" instead of letting a
// guest fill the whole form and hit payments-unavailable at the end;
// createEventBooking re-checks all three (this is UX, not the guard).
export async function eventCheckoutAvailable(eventId: string): Promise<boolean> {
  if (paymentsDisabled() || !stripeEnabled()) return false;
  const [row] = await adminDb()
    .select({ organisationId: specialEvents.organisationId })
    .from(specialEvents)
    .where(eq(specialEvents.id, eventId))
    .limit(1);
  if (!row) return false;
  if (isLocked(await getPlan(row.organisationId), "events")) return false;
  const account = await getAccount(row.organisationId);
  return account !== null && account.chargesEnabled;
}
