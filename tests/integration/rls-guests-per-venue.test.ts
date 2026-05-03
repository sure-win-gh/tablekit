// Per-venue CRM scoping + Plus-tier plan gates.
//
// Asserts:
//   1. loadOrgGuests({ orgId, venueId }) only returns guests with at
//      least one booking at that venue — proves intra-org per-venue
//      filtering works (the load-bearing test). Guest of org A who
//      booked at V1 only must not appear when filtered by V2.
//   2. loadOrgGuests({ orgId }) returns the union — cross-venue path
//      unchanged.
//   3. Cross-tenant: as user A, loadOrgGuests against org B's venue
//      returns []. RLS on `guests` blocks the rows regardless of the
//      SQL filter, so the per-venue lens cannot leak peer-org data.
//   4. requirePlan(orgId, 'plus') throws InsufficientPlanError on a
//      Free or Core org and returns 'plus' on a Plus org. Together
//      with the lens, this is the load-bearing pair: even a Plus org
//      cannot see another tenant's guests via the venue filter, and
//      a Free/Core org cannot enter the lens at all.

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import * as schema from "@/lib/db/schema";
import { loadOrgGuests } from "@/lib/guests/list";
import { upsertGuest } from "@/lib/guests/upsert";

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

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  orgFreeId: string;
  venueA1Id: string;
  venueA2Id: string;
  venueBId: string;
  serviceA1Id: string;
  serviceA2Id: string;
  areaA1Id: string;
  areaA2Id: string;
  tableA1Id: string;
  tableA2Id: string;
  guest1Id: string;
  guest2Id: string;
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

  const userAId = await mkUser(`crm-a-${run}@tablekit.test`);
  const userBId = await mkUser(`crm-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `CRM A ${run}`, slug: `crm-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `CRM B ${run}`, slug: `crm-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgFree] = await db
    .insert(schema.organisations)
    .values({ name: `CRM Free ${run}`, slug: `crm-free-${run}`, plan: "free" })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB || !orgFree) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  // Org A — two venues. Org B — one venue. (Org Free has no venues;
  // we only use it to assert the plan gate.)
  const [venueA1] = await db
    .insert(schema.venues)
    .values({ organisationId: orgA.id, name: "VA1", venueType: "cafe", timezone: "Europe/London" })
    .returning({ id: schema.venues.id });
  const [venueA2] = await db
    .insert(schema.venues)
    .values({ organisationId: orgA.id, name: "VA2", venueType: "cafe", timezone: "Europe/London" })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({ organisationId: orgB.id, name: "VB", venueType: "cafe", timezone: "Europe/London" })
    .returning({ id: schema.venues.id });
  if (!venueA1 || !venueA2 || !venueB) throw new Error("venue insert returned no row");

  // Areas, tables, services — needed so we can insert valid bookings
  // (FK constraints). Booking rows themselves are seeded directly
  // below; we don't go through createBooking because we don't care
  // about availability / state machine here.
  const [areaA1] = await db
    .insert(schema.areas)
    .values({ organisationId: orgA.id, venueId: venueA1.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [areaA2] = await db
    .insert(schema.areas)
    .values({ organisationId: orgA.id, venueId: venueA2.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  if (!areaA1 || !areaA2) throw new Error("area insert returned no row");

  const [tableA1] = await db
    .insert(schema.venueTables)
    .values({
      organisationId: orgA.id,
      venueId: venueA1.id,
      areaId: areaA1.id,
      label: "T1",
      minCover: 1,
      maxCover: 4,
    })
    .returning({ id: schema.venueTables.id });
  const [tableA2] = await db
    .insert(schema.venueTables)
    .values({
      organisationId: orgA.id,
      venueId: venueA2.id,
      areaId: areaA2.id,
      label: "T1",
      minCover: 1,
      maxCover: 4,
    })
    .returning({ id: schema.venueTables.id });
  if (!tableA1 || !tableA2) throw new Error("table insert returned no row");

  const schedule = {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "08:00",
    end: "17:00",
  };
  const [svcA1] = await db
    .insert(schema.services)
    .values({
      organisationId: orgA.id,
      venueId: venueA1.id,
      name: "Open",
      schedule,
      turnMinutes: 45,
    })
    .returning({ id: schema.services.id });
  const [svcA2] = await db
    .insert(schema.services)
    .values({
      organisationId: orgA.id,
      venueId: venueA2.id,
      name: "Open",
      schedule,
      turnMinutes: 45,
    })
    .returning({ id: schema.services.id });
  if (!svcA1 || !svcA2) throw new Error("service insert returned no row");

  // Guests via the canonical upsert (encrypts PII, handles the
  // (org_id, email_hash) dedup index correctly).
  const r1 = await upsertGuest(orgA.id, userAId, {
    firstName: "Alpha",
    lastName: "One",
    email: `alpha-${run}@example.com`,
  });
  const r2 = await upsertGuest(orgA.id, userAId, {
    firstName: "Bravo",
    lastName: "Two",
    email: `bravo-${run}@example.com`,
  });
  const rB = await upsertGuest(orgB.id, userBId, {
    firstName: "Other",
    lastName: "Org",
    email: `other-${run}@example.com`,
  });
  if (!r1.ok || !r2.ok || !rB.ok) throw new Error("guest upsert failed");

  // Booking seed:
  //   guest 1 → 2 bookings at venue A1, none at A2
  //   guest 2 → 1 booking at venue A2, none at A1
  // (We use direct inserts — bypasses createBooking's availability
  // engine. Triggers fill organisationId on bookings and copy denorm.)
  const start = new Date("2026-05-10T11:00:00Z");
  await db.insert(schema.bookings).values([
    {
      organisationId: orgA.id,
      venueId: venueA1.id,
      serviceId: svcA1.id,
      areaId: areaA1.id,
      guestId: r1.guestId,
      partySize: 2,
      startAt: start,
      endAt: new Date(start.getTime() + 45 * 60 * 1000),
      status: "finished",
      source: "host",
    },
    {
      organisationId: orgA.id,
      venueId: venueA1.id,
      serviceId: svcA1.id,
      areaId: areaA1.id,
      guestId: r1.guestId,
      partySize: 2,
      startAt: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
      endAt: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 + 45 * 60 * 1000),
      status: "confirmed",
      source: "host",
    },
    {
      organisationId: orgA.id,
      venueId: venueA2.id,
      serviceId: svcA2.id,
      areaId: areaA2.id,
      guestId: r2.guestId,
      partySize: 4,
      startAt: start,
      endAt: new Date(start.getTime() + 45 * 60 * 1000),
      status: "finished",
      source: "host",
    },
  ]);

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    orgFreeId: orgFree.id,
    venueA1Id: venueA1.id,
    venueA2Id: venueA2.id,
    venueBId: venueB.id,
    serviceA1Id: svcA1.id,
    serviceA2Id: svcA2.id,
    areaA1Id: areaA1.id,
    areaA2Id: areaA2.id,
    tableA1Id: tableA1.id,
    tableA2Id: tableA2.id,
    guest1Id: r1.guestId,
    guest2Id: r2.guestId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgFreeId));
  }
  await pool.end();
});

describe("loadOrgGuests — per-venue scoping", () => {
  it("venue A1 sees only guest 1 (who booked there)", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      loadOrgGuests(tx, { orgId: ctx.orgAId, venueId: ctx.venueA1Id }),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.guest1Id);
    expect(ids).not.toContain(ctx.guest2Id);
    const guest1 = rows.find((r) => r.id === ctx.guest1Id);
    expect(guest1?.visits).toBeGreaterThanOrEqual(1);
  });

  it("venue A2 sees only guest 2 (who booked there)", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      loadOrgGuests(tx, { orgId: ctx.orgAId, venueId: ctx.venueA2Id }),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.guest2Id);
    expect(ids).not.toContain(ctx.guest1Id);
  });

  it("cross-venue mode (no venueId) returns the union", async () => {
    const rows = await asUser(ctx.userAId, (tx) => loadOrgGuests(tx, { orgId: ctx.orgAId }));
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(ctx.guest1Id)).toBe(true);
    expect(ids.has(ctx.guest2Id)).toBe(true);
  });
});

describe("loadOrgGuests — cross-tenant fail-closed", () => {
  it("user A cannot pull org B's guests via the venue lens", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      loadOrgGuests(tx, { orgId: ctx.orgBId, venueId: ctx.venueBId }),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("requirePlan — Plus gate", () => {
  it("Free org throws InsufficientPlanError when 'plus' is required", async () => {
    await expect(requirePlan(ctx.orgFreeId, "plus")).rejects.toBeInstanceOf(InsufficientPlanError);
  });

  it("Plus org returns 'plus'", async () => {
    await expect(requirePlan(ctx.orgAId, "plus")).resolves.toBe("plus");
  });
});
