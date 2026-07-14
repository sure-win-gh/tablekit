// Cross-tenant RLS + trigger test for the `table_combinations` table
// (operator-set table-join edges — docs/specs/table-combining.md).
//
// Confirms:
//   1. The `table_combinations_member_read` policy scopes reads to the
//      caller's org, so user A never sees org B's join edges.
//   2. enforce_table_combinations_denorm() populates org/venue/area from
//      the endpoint tables (overriding a bogus caller value) and RAISEs
//      when the two tables sit in different areas (same-area rule).
//   3. The authenticated role has no insert policy — writes must go
//      through the admin/server-action path.
//
// Setup mirrors rls-venues-cross-tenant.test.ts.

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

// table_a_id < table_b_id is a CHECK constraint; canonicalise the pair.
const canonical = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  areaAId: string;
  areaBId: string;
  tableA1Id: string;
  tableA2Id: string;
  tableB1Id: string;
  tableB2Id: string;
  comboAId: string;
  comboBId: string;
};

const run = Date.now().toString(36);
const emailA = `combo-a-${run}@tablekit.test`;
const emailB = `combo-b-${run}@tablekit.test`;

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
    .values({ name: `Org A ${run}`, slug: `tc-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Org B ${run}`, slug: `tc-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenueAreaTables = async (orgId: string, tag: string) => {
    const [venue] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: `Venue ${tag} ${run}`, venueType: "cafe" })
      .returning({ id: schema.venues.id });
    if (!venue) throw new Error("venue insert returned no row");
    const [area] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId: venue.id, name: `Area ${tag}` })
      .returning({ id: schema.areas.id });
    if (!area) throw new Error("area insert returned no row");
    const [tbl1] = await db
      .insert(schema.venueTables)
      .values({ organisationId: orgId, venueId: venue.id, areaId: area.id, label: "1", maxCover: 2 })
      .returning({ id: schema.venueTables.id });
    const [tbl2] = await db
      .insert(schema.venueTables)
      .values({ organisationId: orgId, venueId: venue.id, areaId: area.id, label: "2", maxCover: 2 })
      .returning({ id: schema.venueTables.id });
    if (!tbl1 || !tbl2) throw new Error("table insert returned no row");
    return { venueId: venue.id, areaId: area.id, t1: tbl1.id, t2: tbl2.id };
  };

  const A = await mkVenueAreaTables(orgA.id, "A");
  const B = await mkVenueAreaTables(orgB.id, "B");

  const [aLo, aHi] = canonical(A.t1, A.t2);
  const [bLo, bHi] = canonical(B.t1, B.t2);
  // Pass a bogus organisation_id/venue_id/area_id on purpose — the
  // denorm trigger must resolve all three from the endpoint tables.
  const [comboA] = await db
    .insert(schema.tableCombinations)
    .values({
      organisationId: orgB.id,
      venueId: B.venueId,
      areaId: B.areaId,
      tableAId: aLo,
      tableBId: aHi,
    })
    .returning({ id: schema.tableCombinations.id });
  const [comboB] = await db
    .insert(schema.tableCombinations)
    .values({
      organisationId: orgA.id,
      venueId: A.venueId,
      areaId: A.areaId,
      tableAId: bLo,
      tableBId: bHi,
    })
    .returning({ id: schema.tableCombinations.id });
  if (!comboA || !comboB) throw new Error("combo insert returned no row");

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    areaAId: A.areaId,
    areaBId: B.areaId,
    tableA1Id: A.t1,
    tableA2Id: A.t2,
    tableB1Id: B.t1,
    tableB2Id: B.t2,
    comboAId: comboA.id,
    comboBId: comboB.id,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    // Org cascade cleans venues → areas → tables → table_combinations.
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("table_combinations RLS cross-tenant isolation", () => {
  it("user A reads only their own join edge", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.tableCombinations));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.comboAId);
    expect(ids).not.toContain(ctx.comboBId);
  });

  it("user B reads only their own join edge (mirror)", async () => {
    const rows = await asUser(ctx.userBId, (tx) => tx.select().from(schema.tableCombinations));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.comboBId);
    expect(ids).not.toContain(ctx.comboAId);
  });

  it("trigger populates org/venue/area from the endpoint tables", async () => {
    const rows = await db
      .select({
        orgId: schema.tableCombinations.organisationId,
        areaId: schema.tableCombinations.areaId,
      })
      .from(schema.tableCombinations)
      .where(eq(schema.tableCombinations.id, ctx.comboAId));
    // Inserted with orgB's id + areaB on purpose; trigger fixed both.
    expect(rows[0]?.orgId).toBe(ctx.orgAId);
    expect(rows[0]?.areaId).toBe(ctx.areaAId);
  });

  it("rejects an edge whose tables are in different areas", async () => {
    const [lo, hi] = canonical(ctx.tableA1Id, ctx.tableB1Id);
    // Drizzle wraps the Postgres RAISE in .cause, so read both layers.
    let message = "";
    try {
      await db.insert(schema.tableCombinations).values({
        organisationId: ctx.orgAId,
        venueId: ctx.areaAId, // irrelevant — trigger resolves
        areaId: ctx.areaAId,
        tableAId: lo,
        tableBId: hi,
      });
      throw new Error("insert should have been rejected");
    } catch (e) {
      const err = e as Error & { cause?: { message?: string } };
      message = `${err.message} ${err.cause?.message ?? ""}`;
    }
    expect(message).toMatch(/same-area|different areas/i);
  });

  it("authenticated role cannot insert a join edge directly", async () => {
    const [lo, hi] = canonical(ctx.tableA1Id, ctx.tableA2Id);
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.tableCombinations).values({
          organisationId: ctx.orgAId,
          venueId: ctx.areaAId,
          areaId: ctx.areaAId,
          tableAId: lo,
          tableBId: hi,
        }),
      ),
    ).rejects.toThrow();
  });
});
