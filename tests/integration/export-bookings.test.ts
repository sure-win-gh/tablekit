// End-to-end coverage of the bookings-export read path.
//
// Asserts:
//   1. loadBookingsForExport joins venue/service/area/guest rows and
//      decrypts guest email under the owning org's DEK.
//   2. RLS + the explicit orgId filter together prevent leakage across
//      orgs — a dual-org user exporting org A sees only org A's
//      bookings. This is the primary contract: the bookings RLS
//      policy is venue-scoped (migration 0013), which spans every org
//      the caller belongs to, so the explicit orgId filter is the
//      only thing that holds.

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { createBooking } from "@/lib/bookings/create";
import { loadBookingsForExport } from "@/lib/export/bookings";

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
const DATE = "2026-05-10"; // Sunday

type Ctx = {
  userAId: string;
  userBId: string;
  userABId: string;
  orgAId: string;
  orgBId: string;
  bookingAId: string;
  bookingBId: string;
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

  const userAId = await mkUser(`exp-bk-a-${run}@tablekit.test`);
  const userBId = await mkUser(`exp-bk-b-${run}@tablekit.test`);
  const userABId = await mkUser(`exp-bk-ab-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `EBK A ${run}`, slug: `ebk-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `EBK B ${run}`, slug: `ebk-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
    { userId: userABId, organisationId: orgA.id, role: "owner" },
    { userId: userABId, organisationId: orgB.id, role: "owner" },
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

  await db.insert(schema.venueTables).values([
    {
      organisationId: orgA.id,
      venueId: venueA.id,
      areaId: areaA.id,
      label: "T1",
      minCover: 1,
      maxCover: 4,
    },
    {
      organisationId: orgB.id,
      venueId: venueB.id,
      areaId: areaB.id,
      label: "T1",
      minCover: 1,
      maxCover: 4,
    },
  ]);

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

  const bA = await createBooking(orgA.id, userAId, {
    venueId: venueA.id,
    serviceId: svcA.id,
    date: DATE,
    wallStart: "12:00",
    partySize: 2,
    source: "host",
    guest: { firstName: "Alice", email: `alice-${run}@example.com` },
  });
  if (!bA.ok) throw new Error(`createBooking A failed: ${bA.reason}`);

  const bB = await createBooking(orgB.id, userBId, {
    venueId: venueB.id,
    serviceId: svcB.id,
    date: DATE,
    wallStart: "13:00",
    partySize: 3,
    source: "host",
    guest: { firstName: "Boris", email: `boris-${run}@example.com` },
  });
  if (!bB.ok) throw new Error(`createBooking B failed: ${bB.reason}`);

  ctx = {
    userAId,
    userBId,
    userABId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    bookingAId: bA.bookingId,
    bookingBId: bB.bookingId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userABId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("loadBookingsForExport", () => {
  it("returns the joined denormalised shape with the guest email decrypted", async () => {
    const rows = await asUser(ctx.userAId, (tx) => loadBookingsForExport(tx, ctx.orgAId));
    const row = rows.find((r) => r.bookingId === ctx.bookingAId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.venueName).toBe("VA");
    expect(row.serviceName).toBe("Open");
    expect(row.areaName).toBe("Inside");
    expect(row.guestFirstName).toBe("Alice");
    expect(row.guestEmail).toBe(`alice-${run}@example.com`);
    expect(row.partySize).toBe(2);
    expect(row.source).toBe("host");
    expect(row.reference).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("dual-org user exporting org A gets only org A's bookings", async () => {
    const rowsA = await asUser(ctx.userABId, (tx) => loadBookingsForExport(tx, ctx.orgAId));
    expect(rowsA.find((r) => r.bookingId === ctx.bookingAId)).toBeDefined();
    expect(rowsA.find((r) => r.bookingId === ctx.bookingBId)).toBeUndefined();

    const rowsB = await asUser(ctx.userABId, (tx) => loadBookingsForExport(tx, ctx.orgBId));
    expect(rowsB.find((r) => r.bookingId === ctx.bookingBId)).toBeDefined();
    expect(rowsB.find((r) => r.bookingId === ctx.bookingAId)).toBeUndefined();
  });

  it("user A under RLS never sees org B's bookings", async () => {
    const rows = await asUser(ctx.userAId, (tx) => loadBookingsForExport(tx, ctx.orgAId));
    expect(rows.find((r) => r.bookingId === ctx.bookingBId)).toBeUndefined();
  });
});
