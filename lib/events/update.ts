// Core DB mutation for editing a special event, split out of the `"use server"`
// action (app/(dashboard)/dashboard/venues/[venueId]/events/actions.ts) so the
// tenant-scoping + area-replace logic can be integration-tested directly — the
// action layer stays a thin zod + requireRole + requirePlan wrapper, matching
// lib/enquiries/operator-actions.ts.
//
// Security: callers pass an `orgId` derived from the session; every write here
// is scoped by it. There is no RLS backstop for the events feature (the whole
// surface uses the service-role client), so the org predicate on the UPDATE is
// the isolation boundary. See docs/playbooks/security.md §Cross-tenant bugs and
// tests/integration/event-update.test.ts.

import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/lib/db/schema";
import { areas, specialEventAreas, specialEvents } from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

export type EventUpdateInput = {
  orgId: string;
  venueId: string;
  eventId: string;
  name: string;
  // Cleared optional fields arrive as null and are written as null.
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  blockScope: "window" | "whole_day";
  externalTicketUrl: string | null;
  // Floor-plan areas the event blocks; empty = whole venue. Replaced wholesale.
  areaIds: string[];
};

export type EventUpdateResult =
  | { ok: true; status: "draft" | "published" | "cancelled" }
  // The event isn't in the caller's org/venue (or doesn't exist) — the caller
  // maps this to a generic "not found" so it can't be used to probe existence.
  | { ok: false; reason: "not-found" }
  // A posted area id doesn't belong to this venue (crafted / cross-tenant).
  | { ok: false; reason: "area-not-in-venue" };

/**
 * Apply an edit to an existing special event and replace its area scope, all
 * scoped to `input.orgId`. Returns a typed result; never throws for the
 * expected not-found / bad-area cases.
 *
 * The slug is intentionally not touched — it's the public URL segment guests
 * may already hold, so a rename never breaks a shared link (and the
 * (venue, slug) unique index can't be violated by an edit).
 */
export async function applyEventUpdate(
  db: Db,
  input: EventUpdateInput,
): Promise<EventUpdateResult> {
  // Every posted area must belong to THIS venue — a crafted id from another
  // venue/org must fail, not silently scope the event. Checked before the tx
  // so a bad request does no writes.
  const scopedAreaIds = [...new Set(input.areaIds)];
  if (scopedAreaIds.length > 0) {
    const venueAreas = await db
      .select({ id: areas.id })
      .from(areas)
      .where(and(eq(areas.venueId, input.venueId), inArray(areas.id, scopedAreaIds)));
    if (venueAreas.length !== scopedAreaIds.length) {
      return { ok: false, reason: "area-not-in-venue" };
    }
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .update(specialEvents)
      .set({
        name: input.name,
        description: input.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        blockScope: input.blockScope,
        externalTicketUrl: input.externalTicketUrl,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(specialEvents.id, input.eventId),
          eq(specialEvents.venueId, input.venueId),
          eq(specialEvents.organisationId, input.orgId),
        ),
      )
      .returning({ id: specialEvents.id, status: specialEvents.status });
    const event = rows[0];
    if (!event) return { ok: false as const, reason: "not-found" as const };

    // Replace the area scope wholesale — simplest correct semantics for an edit
    // (add/remove areas), and the set is tiny. Runs only after the UPDATE
    // confirmed the event is in the caller's org, so the delete can't touch
    // another tenant's junction rows.
    await tx.delete(specialEventAreas).where(eq(specialEventAreas.eventId, event.id));
    if (scopedAreaIds.length > 0) {
      await tx.insert(specialEventAreas).values(
        scopedAreaIds.map((areaId) => ({
          eventId: event.id,
          areaId,
          organisationId: input.orgId,
        })),
      );
    }
    return { ok: true as const, status: event.status };
  });
}
