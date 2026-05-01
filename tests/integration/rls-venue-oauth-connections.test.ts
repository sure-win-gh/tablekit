// Integration tests for the Phase 3a venue_oauth_connections schema.
//
// Covers:
//   1. Cross-tenant RLS — user A never sees org B's connection rows.
//   2. No INSERT/UPDATE/DELETE policies for authenticated.
//   3. enforce_venue_oauth_connections_org_id trigger — spoofed
//      organisation_id is silently corrected to the parent venue's
//      org.
//   4. (venue_id, provider) UNIQUE — second row for same pair rejects.

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

const run = Date.now().toString(36);

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  connectionAId: string;
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

  const userAId = await mkUser(`oauth-a-${run}@tablekit.test`);
  const userBId = await mkUser(`oauth-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `O-A ${run}`, slug: `oauth-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `O-B ${run}`, slug: `oauth-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const [venueA] = await db
    .insert(schema.venues)
    .values({ organisationId: orgA.id, name: "V-A", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({ organisationId: orgB.id, name: "V-B", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  if (!venueA || !venueB) throw new Error("venue insert returned no row");

  const [connectionA] = await db
    .insert(schema.venueOauthConnections)
    .values({
      organisationId: orgA.id,
      venueId: venueA.id,
      provider: "google",
      accessTokenCipher: "v1:placeholder:placeholder:placeholder",
      scopes: "https://www.googleapis.com/auth/business.manage",
    })
    .returning({ id: schema.venueOauthConnections.id });
  await db.insert(schema.venueOauthConnections).values({
    organisationId: orgB.id,
    venueId: venueB.id,
    provider: "google",
    accessTokenCipher: "v1:placeholder:placeholder:placeholder",
    scopes: "https://www.googleapis.com/auth/business.manage",
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId: venueA.id,
    venueBId: venueB.id,
    connectionAId: connectionA!.id,
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

describe("venue_oauth_connections — cross-tenant RLS", () => {
  it("user A sees only their own org's rows", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.venueOauthConnections));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.venueOauthConnections).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          provider: "google",
          accessTokenCipher: "v1:x:x:x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated UPDATE silently affects zero rows", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.venueOauthConnections)
        .set({ scopes: "tampered" })
        .where(eq(schema.venueOauthConnections.id, ctx.connectionAId)),
    );
    const [row] = await db
      .select({ scopes: schema.venueOauthConnections.scopes })
      .from(schema.venueOauthConnections)
      .where(eq(schema.venueOauthConnections.id, ctx.connectionAId));
    expect(row?.scopes).toBe("https://www.googleapis.com/auth/business.manage");
  });

  it("authenticated DELETE silently affects zero rows", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .delete(schema.venueOauthConnections)
        .where(eq(schema.venueOauthConnections.id, ctx.connectionAId)),
    );
    const rows = await db
      .select({ id: schema.venueOauthConnections.id })
      .from(schema.venueOauthConnections)
      .where(eq(schema.venueOauthConnections.id, ctx.connectionAId));
    expect(rows.length).toBe(1);
  });
});

describe("enforce_venue_oauth_connections_org_id trigger", () => {
  it("rewrites a spoofed organisation_id to match the parent venue", async () => {
    const [otherVenue] = await db
      .insert(schema.venues)
      .values({ organisationId: ctx.orgAId, name: "V-A2", venueType: "cafe" })
      .returning({ id: schema.venues.id });
    const [row] = await db
      .insert(schema.venueOauthConnections)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: otherVenue!.id,
        provider: "tripadvisor",
        accessTokenCipher: "v1:x:x:x",
      })
      .returning({
        id: schema.venueOauthConnections.id,
        organisationId: schema.venueOauthConnections.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db
      .delete(schema.venueOauthConnections)
      .where(eq(schema.venueOauthConnections.id, row!.id));
  });
});

describe("(venue_id, provider) UNIQUE", () => {
  it("rejects a second row with the same (venue_id, provider) pair", async () => {
    await expect(
      db.insert(schema.venueOauthConnections).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        provider: "google",
        accessTokenCipher: "v1:x:x:x",
      }),
    ).rejects.toThrow();
  });
});
