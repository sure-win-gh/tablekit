// Integration tests for the venue_photos table (booking-page Phase 2).
//
// Covers:
//   1. Cross-tenant RLS — user A never sees org B's photo rows.
//   2. No INSERT/UPDATE policy for authenticated (writes go via adminDb).
//   3. enforce_venue_photos_org_id trigger — a spoofed organisation_id is
//      corrected to the parent venue's org.
//   4. storage_path unique constraint.

import { eq, sql } from "drizzle-orm";
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

const run = Date.now().toString(36);

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  rowAId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const mkUser = async (email: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "integration-test-pw-1234",
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    return data.user.id;
  };

  const userAId = await mkUser(`vp-a-${run}@tablekit.test`);
  const userBId = await mkUser(`vp-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `VP-A ${run}`, slug: `vp-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `VP-B ${run}`, slug: `vp-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "restaurant" })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgA.id);
  const venueBId = await mkVenue(orgB.id);

  const [rowA] = await db
    .insert(schema.venuePhotos)
    .values({
      organisationId: orgA.id,
      venueId: venueAId,
      storagePath: `${venueAId}/a-${run}.webp`,
    })
    .returning({ id: schema.venuePhotos.id });
  await db.insert(schema.venuePhotos).values({
    organisationId: orgB.id,
    venueId: venueBId,
    storagePath: `${venueBId}/b-${run}.webp`,
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
    rowAId: rowA!.id,
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

describe("venue_photos — cross-tenant RLS", () => {
  it("user A sees only their own org's photos", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.venuePhotos));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.venuePhotos).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          storagePath: `${ctx.venueAId}/hack-${run}.webp`,
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated UPDATE silently affects zero rows", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.venuePhotos)
        .set({ caption: "hacked" })
        .where(eq(schema.venuePhotos.id, ctx.rowAId)),
    );
    const [row] = await db
      .select({ caption: schema.venuePhotos.caption })
      .from(schema.venuePhotos)
      .where(eq(schema.venuePhotos.id, ctx.rowAId));
    expect(row?.caption).toBeNull();
  });
});

describe("enforce_venue_photos_org_id trigger", () => {
  it("rewrites a spoofed organisation_id to match the parent venue", async () => {
    const [row] = await db
      .insert(schema.venuePhotos)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: ctx.venueAId,
        storagePath: `${ctx.venueAId}/spoof-${run}.webp`,
      })
      .returning({
        id: schema.venuePhotos.id,
        organisationId: schema.venuePhotos.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.venuePhotos).where(eq(schema.venuePhotos.id, row!.id));
  });
});

describe("storage_path uniqueness", () => {
  it("rejects a duplicate storage_path", async () => {
    await expect(
      db.insert(schema.venuePhotos).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        storagePath: `${ctx.venueAId}/a-${run}.webp`, // same as rowA
      }),
    ).rejects.toThrow();
  });
});
