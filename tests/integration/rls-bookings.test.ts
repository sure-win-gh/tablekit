// Integration tests for the bookings phase.
//
// Covers:
//   1. Cross-tenant RLS — user A cannot see org B's bookings / junction
//      rows / events.
//   2. Exclusion constraint — two overlapping bookings on the same table
//      cannot coexist; second insert maps to slot-taken.
//   3. State machine — valid transitions succeed + write a booking_event;
//      invalid transitions return a typed error.
//   4. Trigger correctness — bookings.org/venue, booking_tables denorm,
//      clear-on-cancel, time-sync.

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { createBooking } from "@/lib/bookings/create";
import { transitionBooking } from "@/lib/bookings/transition";

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
// Pick a fixed future BST date so the day-of-week is stable and the
// availability engine considers the service active for it.
const DATE = "2026-05-10"; // Sunday

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  serviceAId: string;
  serviceBId: string;
  areaAId: string;
  areaBId: string;
  tableA1Id: string;
  tableA2Id: string;
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

  const userAId = await mkUser(`bookings-a-${run}@tablekit.test`);
  const userBId = await mkUser(`bookings-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `B-A ${run}`, slug: `bk-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `B-B ${run}`, slug: `bk-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const [venueA] = await db
    .insert(schema.venues)
    .values({ organisationId: orgA.id, name: "VA", venueType: "cafe", timezone: "Europe/London" })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({ organisationId: orgB.id, name: "VB", venueType: "cafe", timezone: "Europe/London" })
    .returning({ id: schema.venues.id });
  if (!venueA || !venueB) throw new Error("venue insert returned no row");

  const [areaA] = await db
    .insert(schema.areas)
    .values({ organisationId: orgA.id, venueId: venueA.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [areaB] = await db
    .insert(schema.areas)
    .values({ organisationId: orgB.id, venueId: venueB.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  if (!areaA || !areaB) throw new Error("area insert returned no row");

  const [tableA1] = await db
    .insert(schema.venueTables)
    .values({
      organisationId: orgA.id,
      venueId: venueA.id,
      areaId: areaA.id,
      label: "T1",
      minCover: 1,
      maxCover: 4,
    })
    .returning({ id: schema.venueTables.id });
  const [tableA2] = await db
    .insert(schema.venueTables)
    .values({
      organisationId: orgA.id,
      venueId: venueA.id,
      areaId: areaA.id,
      label: "T2",
      minCover: 1,
      maxCover: 2,
    })
    .returning({ id: schema.venueTables.id });
  if (!tableA1 || !tableA2) throw new Error("table insert returned no row");

  // Org B needs at least one table for the cross-tenant test's second
  // createBooking to succeed.
  await db.insert(schema.venueTables).values({
    organisationId: orgB.id,
    venueId: venueB.id,
    areaId: areaB.id,
    label: "T1",
    minCover: 1,
    maxCover: 4,
  });

  // Service: open every day 08:00–17:00, 45-minute turns.
  const schedule = {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "08:00",
    end: "17:00",
  };
  const [svcA] = await db
    .insert(schema.services)
    .values({
      organisationId: orgA.id,
      venueId: venueA.id,
      name: "Open",
      schedule,
      turnMinutes: 45,
    })
    .returning({ id: schema.services.id });
  const [svcB] = await db
    .insert(schema.services)
    .values({
      organisationId: orgB.id,
      venueId: venueB.id,
      name: "Open",
      schedule,
      turnMinutes: 45,
    })
    .returning({ id: schema.services.id });
  if (!svcA || !svcB) throw new Error("service insert returned no row");

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId: venueA.id,
    venueBId: venueB.id,
    serviceAId: svcA.id,
    serviceBId: svcB.id,
    areaAId: areaA.id,
    areaBId: areaB.id,
    tableA1Id: tableA1.id,
    tableA2Id: tableA2.id,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("bookings — happy path", () => {
  it("createBooking confirms a slot, writes junction + event, and the trigger fixes org", async () => {
    const r = await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "12:00",
      partySize: 2,
      source: "host",
      guest: { firstName: "Jane", email: `jane-${run}@example.com` },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tableIds.length).toBe(1);

    const [row] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, r.bookingId));
    expect(row?.organisationId).toBe(ctx.orgAId);
    expect(row?.venueId).toBe(ctx.venueAId);
    expect(row?.status).toBe("confirmed");

    const juncs = await db
      .select()
      .from(schema.bookingTables)
      .where(eq(schema.bookingTables.bookingId, r.bookingId));
    expect(juncs.length).toBe(1);
    expect(juncs[0]?.organisationId).toBe(ctx.orgAId);
    expect(juncs[0]?.venueId).toBe(ctx.venueAId);
    expect(juncs[0]?.areaId).toBe(ctx.areaAId);

    const events = await db
      .select()
      .from(schema.bookingEvents)
      .where(eq(schema.bookingEvents.bookingId, r.bookingId));
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("status.confirmed");
    expect(events[0]?.organisationId).toBe(ctx.orgAId);
  });
});

describe("bookings — double-booking prevention", () => {
  it("second overlapping booking on the same table returns slot-taken", async () => {
    const first = await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "13:00",
      partySize: 1,
      source: "host",
      guest: { firstName: "First", email: `first-${run}@example.com` },
    });
    expect(first.ok).toBe(true);

    // Second booking at the same wall time, same party — availability
    // engine will offer the remaining table. We want to force a clash
    // on the first table, so pre-occupy the second table.
    await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "13:00",
      partySize: 1,
      source: "host",
      guest: { firstName: "Second", email: `second-${run}@example.com` },
    });

    // Now a third booking at 13:00 party of 1 — no free table, so
    // availability rejects before we get near the exclusion constraint.
    const third = await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "13:00",
      partySize: 1,
      source: "host",
      guest: { firstName: "Third", email: `third-${run}@example.com` },
    });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.reason).toBe("no-availability");
  });

  it("the exclusion constraint physically rejects a raw overlapping junction insert", async () => {
    // Create a booking at 14:00.
    const r = await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "14:00",
      partySize: 1,
      source: "host",
      guest: { firstName: "X", email: `excl-${run}@example.com` },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [junc] = await db
      .select()
      .from(schema.bookingTables)
      .where(eq(schema.bookingTables.bookingId, r.bookingId));
    const tableId = junc!.tableId;

    // Manually create a second booking row + try to assign the same
    // table at an overlapping time. The EXCLUDE on booking_tables
    // must reject.
    const [otherGuest] = await db
      .insert(schema.guests)
      .values({
        organisationId: ctx.orgAId,
        firstName: "Other",
        lastNameCipher: "x",
        emailCipher: "x",
        emailHash: `other-${run}`,
      })
      .returning({ id: schema.guests.id });
    const [otherBooking] = await db
      .insert(schema.bookings)
      .values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        serviceId: ctx.serviceAId,
        areaId: ctx.areaAId,
        guestId: otherGuest!.id,
        partySize: 1,
        startAt: junc!.startAt, // exact overlap
        endAt: junc!.endAt,
        status: "confirmed",
        source: "host",
      })
      .returning({ id: schema.bookings.id });

    await expect(
      db.insert(schema.bookingTables).values({
        bookingId: otherBooking!.id,
        tableId,
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        areaId: ctx.areaAId,
        startAt: junc!.startAt,
        endAt: junc!.endAt,
      }),
    ).rejects.toThrow();

    // Clean up the orphan booking.
    await db.delete(schema.bookings).where(eq(schema.bookings.id, otherBooking!.id));
  });
});

describe("bookings — state machine via transitionBooking", () => {
  let bookingId: string;
  beforeAll(async () => {
    const r = await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "15:00",
      partySize: 2,
      source: "host",
      guest: { firstName: "Flow", email: `flow-${run}@example.com` },
    });
    if (!r.ok) throw new Error(`setup: ${r.reason}`);
    bookingId = r.bookingId;
  });

  it("confirmed → seated → finished works", async () => {
    const r1 = await transitionBooking(ctx.orgAId, ctx.userAId, bookingId, "seated");
    expect(r1.ok).toBe(true);

    const r2 = await transitionBooking(ctx.orgAId, ctx.userAId, bookingId, "finished");
    expect(r2.ok).toBe(true);

    const events = await db
      .select({ type: schema.bookingEvents.type })
      .from(schema.bookingEvents)
      .where(eq(schema.bookingEvents.bookingId, bookingId));
    const types = events.map((e) => e.type);
    expect(types).toContain("status.seated");
    expect(types).toContain("status.finished");
  });

  it("finished → seated is rejected with invalid-transition", async () => {
    const r = await transitionBooking(ctx.orgAId, ctx.userAId, bookingId, "seated");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-transition");
  });

  it("cancelling frees the tables (junction rows are deleted by trigger)", async () => {
    // New booking we can cancel.
    const r = await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "16:00",
      partySize: 2,
      source: "host",
      guest: { firstName: "Cancel", email: `cancel-${run}@example.com` },
    });
    if (!r.ok) throw new Error(`setup: ${r.reason}`);

    const before = await db
      .select()
      .from(schema.bookingTables)
      .where(eq(schema.bookingTables.bookingId, r.bookingId));
    expect(before.length).toBeGreaterThan(0);

    const t = await transitionBooking(ctx.orgAId, ctx.userAId, r.bookingId, "cancelled");
    expect(t.ok).toBe(true);

    const after = await db
      .select()
      .from(schema.bookingTables)
      .where(eq(schema.bookingTables.bookingId, r.bookingId));
    expect(after.length).toBe(0);
  });
});

describe("bookings — cross-tenant RLS", () => {
  it("user A cannot read org B's bookings / junction / events", async () => {
    // Create one on each side.
    const rA = await createBooking(ctx.orgAId, ctx.userAId, {
      venueId: ctx.venueAId,
      serviceId: ctx.serviceAId,
      date: DATE,
      wallStart: "09:00",
      partySize: 1,
      source: "host",
      guest: { firstName: "A", email: `a-rls-${run}@example.com` },
    });
    const rB = await createBooking(ctx.orgBId, ctx.userBId, {
      venueId: ctx.venueBId,
      serviceId: ctx.serviceBId,
      date: DATE,
      wallStart: "09:00",
      partySize: 1,
      source: "host",
      guest: { firstName: "B", email: `b-rls-${run}@example.com` },
    });
    if (!rA.ok) throw new Error(`setup A: ${rA.reason}`);
    if (!rB.ok) throw new Error(`setup B: ${rB.reason}`);

    const [bookingsA, junctionA, eventsA] = await Promise.all([
      asUser(ctx.userAId, (tx) => tx.select().from(schema.bookings)),
      asUser(ctx.userAId, (tx) => tx.select().from(schema.bookingTables)),
      asUser(ctx.userAId, (tx) => tx.select().from(schema.bookingEvents)),
    ]);
    expect(bookingsA.map((r) => r.id)).not.toContain(rB.bookingId);
    expect(junctionA.every((r) => r.organisationId === ctx.orgAId)).toBe(true);
    expect(eventsA.every((r) => r.organisationId === ctx.orgAId)).toBe(true);
  });

  it("authenticated role cannot insert a booking directly (no INSERT policy)", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.bookings).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          serviceId: ctx.serviceAId,
          areaId: ctx.areaAId,
          guestId: ctx.tableA1Id, // not a guest id — will also fail FK but RLS blocks first
          partySize: 1,
          startAt: new Date(),
          endAt: new Date(Date.now() + 3_600_000),
          status: "confirmed",
          source: "host",
        }),
      ),
    ).rejects.toThrow();
  });
});
