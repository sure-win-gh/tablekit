// Integration test for the special-event edit path (applyEventUpdate,
// lib/events/update.ts) — the DB logic behind the `updateSpecialEvent` server
// action (docs/specs/special-events.md).
//
// The events feature has no RLS backstop (service-role client throughout), so
// the org predicate on the UPDATE is the tenant-isolation boundary. These
// assert it directly against a live DB — the guard the security review asked
// for:
//   1. Happy path: an org edits its own event; fields change, slug is NOT
//      regenerated, cleared optionals become NULL, area scope is replaced.
//   2. Cross-tenant: editing another org's event returns not-found and mutates
//      nothing.
//   3. Area injection: a crafted area id from another venue/org is rejected
//      before any write, so no cross-tenant junction row is created.
//
// Setup mirrors rls-special-events.test.ts. Uses the plain service-role pool
// (no RLS context) — exactly the client the action passes in via adminDb().

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { applyEventUpdate } from "@/lib/events/update";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = {
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  areaA1Id: string;
  areaA2Id: string;
  areaB1Id: string;
  eventAId: string;
  eventBId: string;
  eventASlug: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const mkOrg = async (tag: string) => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: `EvtUpd ${tag} ${run}`, slug: `evt-upd-${tag}-${run}`, plan: "plus" })
      .returning({ id: schema.organisations.id });
    if (!org) throw new Error("org insert returned no row");
    return org.id;
  };
  const mkVenue = async (orgId: string, tag: string) => {
    const [venue] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: `Venue ${tag}`, venueType: "restaurant" })
      .returning({ id: schema.venues.id });
    if (!venue) throw new Error("venue insert returned no row");
    return venue.id;
  };
  const mkArea = async (orgId: string, venueId: string, name: string) => {
    const [area] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId, name })
      .returning({ id: schema.areas.id });
    if (!area) throw new Error("area insert returned no row");
    return area.id;
  };
  const mkEvent = async (orgId: string, venueId: string, slug: string, areaId: string) => {
    const [event] = await db
      .insert(schema.specialEvents)
      .values({
        organisationId: orgId,
        venueId,
        slug,
        name: "Original Name",
        description: "Original description",
        externalTicketUrl: "https://example.com/tickets",
        startsAt: new Date("2026-11-21T00:00:00Z"),
        endsAt: new Date("2026-11-22T00:00:00Z"),
        status: "published",
        blockScope: "whole_day",
      })
      .returning({ id: schema.specialEvents.id });
    if (!event) throw new Error("event insert returned no row");
    await db
      .insert(schema.specialEventAreas)
      .values({ eventId: event.id, areaId, organisationId: orgId });
    return event.id;
  };

  const orgAId = await mkOrg("A");
  const orgBId = await mkOrg("B");
  const venueAId = await mkVenue(orgAId, "A");
  const venueBId = await mkVenue(orgBId, "B");
  const areaA1Id = await mkArea(orgAId, venueAId, "A1");
  const areaA2Id = await mkArea(orgAId, venueAId, "A2");
  const areaB1Id = await mkArea(orgBId, venueBId, "B1");
  const eventASlug = `event-a-${run}`;
  const eventAId = await mkEvent(orgAId, venueAId, eventASlug, areaA1Id);
  const eventBId = await mkEvent(orgBId, venueBId, `event-b-${run}`, areaB1Id);

  ctx = {
    orgAId,
    orgBId,
    venueAId,
    venueBId,
    areaA1Id,
    areaA2Id,
    areaB1Id,
    eventAId,
    eventBId,
    eventASlug,
  };
});

afterAll(async () => {
  if (ctx) {
    // Org cascade cleans venues → special_events → special_event_areas.
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

const baseInput = (over: Partial<Parameters<typeof applyEventUpdate>[1]>) => ({
  orgId: ctx.orgAId,
  venueId: ctx.venueAId,
  eventId: ctx.eventAId,
  name: "Original Name",
  description: "Original description" as string | null,
  startsAt: new Date("2026-11-21T00:00:00Z"),
  endsAt: new Date("2026-11-22T00:00:00Z"),
  blockScope: "whole_day" as const,
  externalTicketUrl: "https://example.com/tickets" as string | null,
  areaIds: [ctx.areaA1Id],
  ...over,
});

async function readEvent(id: string) {
  const [row] = await db.select().from(schema.specialEvents).where(eq(schema.specialEvents.id, id));
  return row;
}
async function readAreaIds(eventId: string) {
  const rows = await db
    .select({ areaId: schema.specialEventAreas.areaId })
    .from(schema.specialEventAreas)
    .where(eq(schema.specialEventAreas.eventId, eventId));
  return rows.map((r) => r.areaId).sort();
}

describe("applyEventUpdate — tenant isolation + edit semantics", () => {
  it("edits its own event: fields change, slug unchanged, optionals cleared, areas replaced", async () => {
    const result = await applyEventUpdate(
      db,
      baseInput({
        name: "Renamed Event",
        description: null, // cleared
        externalTicketUrl: null, // cleared
        blockScope: "window",
        startsAt: new Date("2026-11-21T18:00:00Z"),
        endsAt: new Date("2026-11-21T23:00:00Z"),
        areaIds: [ctx.areaA2Id], // replace A1 → A2
      }),
    );

    expect(result).toEqual({ ok: true, status: "published" });

    const ev = await readEvent(ctx.eventAId);
    expect(ev?.name).toBe("Renamed Event");
    expect(ev?.description).toBeNull();
    expect(ev?.externalTicketUrl).toBeNull();
    expect(ev?.blockScope).toBe("window");
    expect(ev?.startsAt.toISOString()).toBe("2026-11-21T18:00:00.000Z");
    // Slug must never change on edit — a shared public link stays valid.
    expect(ev?.slug).toBe(ctx.eventASlug);
    // Area scope replaced wholesale.
    expect(await readAreaIds(ctx.eventAId)).toEqual([ctx.areaA2Id]);
  });

  it("cannot edit another org's event (org predicate) → not-found, no mutation", async () => {
    const before = await readEvent(ctx.eventBId);
    const result = await applyEventUpdate(
      db,
      baseInput({
        orgId: ctx.orgAId, // authed as A
        venueId: ctx.venueBId,
        eventId: ctx.eventBId, // …targeting B's event
        name: "Hijacked",
        areaIds: [],
      }),
    );

    expect(result).toEqual({ ok: false, reason: "not-found" });
    const after = await readEvent(ctx.eventBId);
    expect(after?.name).toBe(before?.name); // untouched
    expect(after?.name).toBe("Original Name");
  });

  it("rejects an area id from another venue/org before any write", async () => {
    const before = await readEvent(ctx.eventAId);
    const result = await applyEventUpdate(
      db,
      baseInput({
        name: "Should Not Persist",
        areaIds: [ctx.areaB1Id], // org B's area
      }),
    );

    expect(result).toEqual({ ok: false, reason: "area-not-in-venue" });
    // The name change must NOT have persisted (validation is before the tx).
    const after = await readEvent(ctx.eventAId);
    expect(after?.name).toBe(before?.name);
    // No cross-tenant junction row leaked in.
    expect(await readAreaIds(ctx.eventAId)).not.toContain(ctx.areaB1Id);
  });
});
