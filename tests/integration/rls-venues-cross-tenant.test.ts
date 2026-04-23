// Cross-tenant RLS test for the four venue-phase tables:
// venues, areas, tables, services.
//
// Confirms two guarantees the `venues` phase makes:
//   1. The `..._member_read` policies use `organisation_id IN
//      user_organisation_ids()`, so user A's authed-role query
//      returns only their org's rows across every venue-scoped
//      table.
//   2. The denormalisation triggers
//      (enforce_areas_org_id, enforce_tables_org_and_venue,
//      enforce_services_org_id) actually populate organisation_id
//      from the parent, even if the caller tried to supply a
//      different one.
//
// Setup mirrors the auth RLS test's approach (admin.auth.admin
// .createUser for each user; direct SQL for org + memberships +
// venues + children).

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

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

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  areaAId: string;
  areaBId: string;
  tableAId: string;
  tableBId: string;
  serviceAId: string;
  serviceBId: string;
};

const run = Date.now().toString(36);
const emailA = `venues-a-${run}@tablekit.test`;
const emailB = `venues-b-${run}@tablekit.test`;

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

  const userAId = await mkUser(emailA);
  const userBId = await mkUser(emailB);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Org A ${run}`, slug: `rv-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Org B ${run}`, slug: `rv-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  // One venue, one area, one table, one service per org.
  const [venueA] = await db
    .insert(schema.venues)
    .values({
      organisationId: orgA.id,
      name: `Venue A ${run}`,
      venueType: "cafe",
    })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({
      organisationId: orgB.id,
      name: `Venue B ${run}`,
      venueType: "cafe",
    })
    .returning({ id: schema.venues.id });
  if (!venueA || !venueB) throw new Error("venue insert returned no row");

  const [areaA] = await db
    .insert(schema.areas)
    // organisation_id is OVERWRITTEN by the trigger from parent venue.
    // We pass the WRONG one on purpose to prove the trigger fixes it
    // (see the "trigger enforces parent org" test below).
    .values({ organisationId: orgB.id, venueId: venueA.id, name: "Area A" })
    .returning({ id: schema.areas.id });
  const [areaB] = await db
    .insert(schema.areas)
    .values({ organisationId: orgA.id, venueId: venueB.id, name: "Area B" })
    .returning({ id: schema.areas.id });
  if (!areaA || !areaB) throw new Error("area insert returned no row");

  const [tableA] = await db
    .insert(schema.venueTables)
    // Wrong organisation_id + wrong venue_id on purpose. Trigger
    // resolves both from the parent area.
    .values({
      organisationId: orgB.id,
      venueId: venueB.id,
      areaId: areaA.id,
      label: "T1",
      maxCover: 4,
    })
    .returning({ id: schema.venueTables.id });
  const [tableB] = await db
    .insert(schema.venueTables)
    .values({
      organisationId: orgA.id,
      venueId: venueA.id,
      areaId: areaB.id,
      label: "T2",
      maxCover: 4,
    })
    .returning({ id: schema.venueTables.id });
  if (!tableA || !tableB) throw new Error("table insert returned no row");

  const [svcA] = await db
    .insert(schema.services)
    .values({
      organisationId: orgB.id, // wrong — trigger fixes
      venueId: venueA.id,
      name: "Service A",
      schedule: { days: ["mon"], start: "09:00", end: "17:00" },
    })
    .returning({ id: schema.services.id });
  const [svcB] = await db
    .insert(schema.services)
    .values({
      organisationId: orgA.id,
      venueId: venueB.id,
      name: "Service B",
      schedule: { days: ["mon"], start: "09:00", end: "17:00" },
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
    areaAId: areaA.id,
    areaBId: areaB.id,
    tableAId: tableA.id,
    tableBId: tableB.id,
    serviceAId: svcA.id,
    serviceBId: svcB.id,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    // Venue cascade cleans areas / tables / services.
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("venues RLS cross-tenant isolation", () => {
  it("user A reads only their venue, not org B's", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.venues));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.venueAId);
    expect(ids).not.toContain(ctx.venueBId);
  });

  it("user A reads only their areas", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.areas));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.areaAId);
    expect(ids).not.toContain(ctx.areaBId);
  });

  it("user A reads only their tables", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.venueTables));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.tableAId);
    expect(ids).not.toContain(ctx.tableBId);
  });

  it("user A reads only their services", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.services));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.serviceAId);
    expect(ids).not.toContain(ctx.serviceBId);
  });

  it("user B sees the mirror subset from their side", async () => {
    // Belt-and-braces — isolation works in both directions, not just A.
    const [venuesRows, areasRows, tableRows, servicesRows] = await Promise.all([
      asUser(ctx.userBId, (tx) => tx.select().from(schema.venues)),
      asUser(ctx.userBId, (tx) => tx.select().from(schema.areas)),
      asUser(ctx.userBId, (tx) => tx.select().from(schema.venueTables)),
      asUser(ctx.userBId, (tx) => tx.select().from(schema.services)),
    ]);
    expect(venuesRows.map((r) => r.id)).not.toContain(ctx.venueAId);
    expect(areasRows.map((r) => r.id)).not.toContain(ctx.areaAId);
    expect(tableRows.map((r) => r.id)).not.toContain(ctx.tableAId);
    expect(servicesRows.map((r) => r.id)).not.toContain(ctx.serviceAId);
  });

  it("trigger overrides a bogus organisation_id on areas", async () => {
    // The insert in beforeAll passed orgB's id for area A; the
    // trigger must have replaced it with the parent venue's orgA.
    const rows = await db
      .select({ orgId: schema.areas.organisationId })
      .from(schema.areas)
      .where(eq(schema.areas.id, ctx.areaAId));
    expect(rows[0]?.orgId).toBe(ctx.orgAId);
  });

  it("trigger overrides both organisation_id and venue_id on tables", async () => {
    const rows = await db
      .select({
        orgId: schema.venueTables.organisationId,
        venueId: schema.venueTables.venueId,
      })
      .from(schema.venueTables)
      .where(eq(schema.venueTables.id, ctx.tableAId));
    expect(rows[0]?.orgId).toBe(ctx.orgAId);
    expect(rows[0]?.venueId).toBe(ctx.venueAId);
  });

  it("trigger overrides a bogus organisation_id on services", async () => {
    const rows = await db
      .select({ orgId: schema.services.organisationId })
      .from(schema.services)
      .where(eq(schema.services.id, ctx.serviceAId));
    expect(rows[0]?.orgId).toBe(ctx.orgAId);
  });

  it("authenticated role cannot insert a venue into another org directly", async () => {
    // RLS has no insert policy for authenticated, so even the correct
    // org id fails under the authed role; this codifies that.
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.venues).values({
          organisationId: ctx.orgBId,
          name: "hijacked",
          venueType: "cafe",
        }),
      ),
    ).rejects.toThrow();
  });
});
