// Integration tests for service_capacity_overrides.
//
// Proves two things the migration is responsible for:
//   1. RLS isolation — a member of org A can read its own override row and
//      cannot see org B's (the member_read policy).
//   2. The enforce_service_capacity_overrides_org_id trigger stamps
//      organisation_id from the parent service, even when the insert passes
//      a wrong/placeholder org id.

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BookingStatus } from "@/lib/bookings/state";
import * as schema from "@/lib/db/schema";
import { getServiceSummary } from "@/lib/services/summary";

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
const TZ = "Europe/London";

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  serviceAId: string;
  serviceBId: string;
  overrideAId: string;
};
let ctx: Ctx;

// All services run every day, so any date works for the summary test.
const SUMMARY_DATE = "2026-06-15";

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
  const userAId = await mkUser(`svc-a-${run}@tablekit.test`);
  const userBId = await mkUser(`svc-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `S-A ${run}`, slug: `svc-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `S-B ${run}`, slug: `svc-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "cafe", timezone: TZ })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const schedule = {
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    start: "12:00",
    end: "22:00",
  };
  const mkService = async (orgId: string, venueId: string) => {
    const [s] = await db
      .insert(schema.services)
      .values({ organisationId: orgId, venueId, name: "Main", schedule, turnMinutes: 90 })
      .returning({ id: schema.services.id });
    return s!.id;
  };
  const venueAId = await mkVenue(orgA.id);
  const venueBId = await mkVenue(orgB.id);
  const serviceAId = await mkService(orgA.id, venueAId);
  const serviceBId = await mkService(orgB.id, venueBId);

  // Insert overrides. Deliberately pass orgB.id as the organisation_id for
  // service A's override to prove the trigger overwrites it with the
  // correct (service A's) org.
  const [overrideA] = await db
    .insert(schema.serviceCapacityOverrides)
    .values({ organisationId: orgB.id, serviceId: serviceAId, capacity: 40 })
    .returning({ id: schema.serviceCapacityOverrides.id });
  await db
    .insert(schema.serviceCapacityOverrides)
    .values({ organisationId: orgB.id, serviceId: serviceBId, capacity: 60 });

  // Summary fixture on venue A: an area + two tables (room capacity 4+6=10),
  // a second service "Brunch" with NO override (so it falls back to room
  // capacity), and bookings on SUMMARY_DATE. Service "Main" keeps its
  // override of 40.
  const [areaA] = await db
    .insert(schema.areas)
    .values({ organisationId: orgA.id, venueId: venueAId, name: "Inside" })
    .returning({ id: schema.areas.id });
  await db.insert(schema.venueTables).values([
    {
      organisationId: orgA.id,
      venueId: venueAId,
      areaId: areaA!.id,
      label: "T1",
      minCover: 1,
      maxCover: 4,
      position: { x: 0, y: 0 },
    },
    {
      organisationId: orgA.id,
      venueId: venueAId,
      areaId: areaA!.id,
      label: "T2",
      minCover: 1,
      maxCover: 6,
      position: { x: 1, y: 0 },
    },
  ]);
  const [serviceA2] = await db
    .insert(schema.services)
    .values({
      organisationId: orgA.id,
      venueId: venueAId,
      name: "Brunch",
      schedule,
      turnMinutes: 90,
    })
    .returning({ id: schema.services.id });
  const [guestA] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgA.id,
      firstName: "G",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `svc_hash_${run}`,
    })
    .returning({ id: schema.guests.id });
  // 13:00 BST = 12:00 UTC, inside the 12:00–22:00 window.
  const mkSummaryBooking = (serviceId: string, party: number, status: BookingStatus) =>
    db.insert(schema.bookings).values({
      organisationId: orgA.id,
      venueId: venueAId,
      serviceId,
      areaId: areaA!.id,
      guestId: guestA!.id,
      partySize: party,
      startAt: new Date(`${SUMMARY_DATE}T12:00:00Z`),
      endAt: new Date(`${SUMMARY_DATE}T13:30:00Z`),
      status,
      source: "host",
    });
  await mkSummaryBooking(serviceAId, 8, "confirmed"); // Main: 8 / 40
  await mkSummaryBooking(serviceA2!.id, 5, "confirmed"); // Brunch: 5 / 10
  await mkSummaryBooking(serviceA2!.id, 3, "cancelled"); // excluded from booked

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
    serviceAId,
    serviceBId,
    overrideAId: overrideA!.id,
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

describe("service_capacity_overrides — org-id trigger", () => {
  it("stamps organisation_id from the parent service, ignoring the passed value", async () => {
    const [row] = await db
      .select({ organisationId: schema.serviceCapacityOverrides.organisationId })
      .from(schema.serviceCapacityOverrides)
      .where(eq(schema.serviceCapacityOverrides.id, ctx.overrideAId));
    // Inserted with orgB.id, but service A belongs to org A → trigger fixes it.
    expect(row?.organisationId).toBe(ctx.orgAId);
  });
});

describe("service_capacity_overrides — RLS", () => {
  it("member of org A reads its own override row", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ capacity: schema.serviceCapacityOverrides.capacity })
        .from(schema.serviceCapacityOverrides)
        .where(eq(schema.serviceCapacityOverrides.serviceId, ctx.serviceAId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capacity).toBe(40);
  });

  it("member of org A cannot see org B's override row — isolation", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ id: schema.serviceCapacityOverrides.id })
        .from(schema.serviceCapacityOverrides)
        .where(eq(schema.serviceCapacityOverrides.serviceId, ctx.serviceBId)),
    );
    expect(rows).toEqual([]);
  });
});

describe("getServiceSummary", () => {
  it("computes capacity (override + room fallback), booked covers, and utilisation", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      getServiceSummary(tx, ctx.venueAId, SUMMARY_DATE, TZ),
    );
    const byName = new Map(rows.map((r) => [r.serviceName, r]));

    // Main: capacity from the override (40), 8 booked covers → 0.2.
    const main = byName.get("Main");
    expect(main?.capacity).toBe(40);
    expect(main?.bookedCovers).toBe(8);
    expect(main?.utilisation).toBeCloseTo(0.2, 5);

    // Brunch: no override → room capacity (4 + 6 = 10); 5 booked (the
    // cancelled party of 3 is excluded) → 0.5.
    const brunch = byName.get("Brunch");
    expect(brunch?.capacity).toBe(10);
    expect(brunch?.bookedCovers).toBe(5);
    expect(brunch?.utilisation).toBeCloseTo(0.5, 5);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      getServiceSummary(tx, ctx.venueBId, SUMMARY_DATE, TZ),
    );
    expect(rows).toEqual([]);
  });
});
