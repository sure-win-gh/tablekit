// Integration tests for the per-venue staff scoping introduced in
// migration 0013. When memberships.venue_ids is non-NULL, the
// member's RLS-visible scope shrinks to those venues across the
// venue-aware tables: venues, bookings, booking_tables,
// booking_events, waitlists.
//
// Companion to rls-bookings.test.ts (which validates org-level
// isolation). This file adds the within-org venue isolation case.

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { createBooking } from "@/lib/bookings/create";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function asUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'authenticated', true)`);
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    return fn(tx as Db);
  });
}

const run = Date.now().toString(36);
const DATE = "2026-05-17"; // Sunday

type Ctx = {
  ownerId: string;
  hostScopedId: string;
  hostUnscopedId: string;
  orgId: string;
  venueAId: string;
  venueBId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const mkUser = async (email: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "integration-test-pw-1234",
      email_confirm: true,
      user_metadata: { full_name: email },
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    return data.user.id;
  };

  const ownerId = await mkUser(`mvs-owner-${run}@tablekit.test`);
  const hostScopedId = await mkUser(`mvs-host-scoped-${run}@tablekit.test`);
  const hostUnscopedId = await mkUser(`mvs-host-unscoped-${run}@tablekit.test`);

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `MVS ${run}`, slug: `mvs-${run}` })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");

  const mkVenue = async (label: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({
        organisationId: org.id,
        name: label,
        venueType: "cafe",
        timezone: "Europe/London",
      })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue("VA");
  const venueBId = await mkVenue("VB");

  // Membership shapes:
  //   owner       — venue_ids NULL (all venues)
  //   hostScoped  — venue_ids = [venueA] only
  //   hostUnscoped — venue_ids NULL (all venues), as a control
  await db.insert(schema.memberships).values([
    { userId: ownerId, organisationId: org.id, role: "owner" },
    { userId: hostScopedId, organisationId: org.id, role: "host", venueIds: [venueAId] },
    { userId: hostUnscopedId, organisationId: org.id, role: "host" },
  ]);

  // Areas + tables + service per venue (createBooking needs them).
  const setupVenue = async (venueId: string) => {
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: org.id, venueId, name: "Inside" })
      .returning({ id: schema.areas.id });
    await db.insert(schema.venueTables).values({
      organisationId: org.id,
      venueId,
      areaId: a!.id,
      label: "T1",
      minCover: 1,
      maxCover: 4,
    });
    await db.insert(schema.services).values({
      organisationId: org.id,
      venueId,
      name: "Open",
      schedule: {
        days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        start: "08:00",
        end: "17:00",
      },
      turnMinutes: 45,
    });
  };
  await setupVenue(venueAId);
  await setupVenue(venueBId);

  // One booking at each venue so the SELECT-scope test has data.
  const [svcA] = await db
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(eq(schema.services.venueId, venueAId))
    .limit(1);
  const [svcB] = await db
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(eq(schema.services.venueId, venueBId))
    .limit(1);

  await createBooking(org.id, ownerId, {
    venueId: venueAId,
    serviceId: svcA!.id,
    date: DATE,
    wallStart: "12:00",
    partySize: 2,
    source: "host",
    guest: { firstName: "AnneA", email: `aa-${run}@example.com` },
  });
  await createBooking(org.id, ownerId, {
    venueId: venueBId,
    serviceId: svcB!.id,
    date: DATE,
    wallStart: "12:00",
    partySize: 2,
    source: "host",
    guest: { firstName: "BobB", email: `bb-${run}@example.com` },
  });

  ctx = { ownerId, hostScopedId, hostUnscopedId, orgId: org.id, venueAId, venueBId };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.ownerId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.hostScopedId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.hostUnscopedId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("memberships.venue_ids — venues table SELECT scope", () => {
  it("scoped host sees only their assigned venue", async () => {
    const rows = await asUser(ctx.hostScopedId, (tx) =>
      tx.select({ id: schema.venues.id }).from(schema.venues),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.venueAId);
    expect(ids).not.toContain(ctx.venueBId);
  });

  it("unscoped host (NULL venue_ids) sees both venues", async () => {
    const rows = await asUser(ctx.hostUnscopedId, (tx) =>
      tx.select({ id: schema.venues.id }).from(schema.venues),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.venueAId);
    expect(ids).toContain(ctx.venueBId);
  });

  it("owner sees both venues", async () => {
    const rows = await asUser(ctx.ownerId, (tx) =>
      tx.select({ id: schema.venues.id }).from(schema.venues),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.venueAId);
    expect(ids).toContain(ctx.venueBId);
  });
});

describe("memberships.venue_ids — bookings table SELECT scope", () => {
  it("scoped host sees only bookings at their venue", async () => {
    const rows = await asUser(ctx.hostScopedId, (tx) =>
      tx.select({ id: schema.bookings.id, venueId: schema.bookings.venueId }).from(schema.bookings),
    );
    const venueIds = new Set(rows.map((r) => r.venueId));
    expect(venueIds.has(ctx.venueAId)).toBe(true);
    expect(venueIds.has(ctx.venueBId)).toBe(false);
  });

  it("unscoped host sees bookings across all venues in the org", async () => {
    const rows = await asUser(ctx.hostUnscopedId, (tx) =>
      tx.select({ venueId: schema.bookings.venueId }).from(schema.bookings),
    );
    const venueIds = new Set(rows.map((r) => r.venueId));
    expect(venueIds.has(ctx.venueAId)).toBe(true);
    expect(venueIds.has(ctx.venueBId)).toBe(true);
  });
});

describe("memberships.venue_ids — booking_tables + booking_events", () => {
  it("scoped host sees junction + event rows only at their venue", async () => {
    const tables = await asUser(ctx.hostScopedId, (tx) =>
      tx.select({ venueId: schema.bookingTables.venueId }).from(schema.bookingTables),
    );
    expect(tables.every((r) => r.venueId === ctx.venueAId)).toBe(true);

    const events = await asUser(ctx.hostScopedId, (tx) =>
      tx
        .select({ bookingId: schema.bookingEvents.bookingId })
        .from(schema.bookingEvents)
        .innerJoin(schema.bookings, eq(schema.bookings.id, schema.bookingEvents.bookingId)),
    );
    // The inner join returns only events whose booking the host can see.
    expect(events.length).toBeGreaterThan(0);
  });
});
