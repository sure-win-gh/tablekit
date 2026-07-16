// Public read for a single published special event (the /events landing
// page). Uses `adminDb` to bypass RLS for anonymous traffic — same posture
// as the rest of lib/public/*, so this file must project out anything that
// isn't meant to be public. Only `published` events are ever returned.
//
// See docs/specs/special-events.md.

import "server-only";

import { and, eq } from "drizzle-orm";

import { specialEvents } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

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
