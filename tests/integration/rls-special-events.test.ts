// Cross-tenant RLS test for the `special_events` table
// (docs/specs/special-events.md).
//
// Confirms:
//   1. The `special_events_member_read` policy scopes reads to the
//      caller's org, so user A never sees org B's events.
//   2. The authenticated role has no insert policy — writes must go
//      through the admin / server-action path (adminDb()).
//
// Setup mirrors rls-table-combinations.test.ts.

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
  eventAId: string;
  eventBId: string;
};

const run = Date.now().toString(36);
const emailA = `evt-a-${run}@tablekit.test`;
const emailB = `evt-b-${run}@tablekit.test`;

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
    .values({ name: `Org A ${run}`, slug: `evt-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Org B ${run}`, slug: `evt-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string, tag: string) => {
    const [venue] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: `Venue ${tag} ${run}`, venueType: "restaurant" })
      .returning({ id: schema.venues.id });
    if (!venue) throw new Error("venue insert returned no row");
    return venue.id;
  };

  const venueAId = await mkVenue(orgA.id, "A");
  const venueBId = await mkVenue(orgB.id, "B");

  const mkEvent = async (orgId: string, venueId: string, tag: string) => {
    const [event] = await db
      .insert(schema.specialEvents)
      .values({
        organisationId: orgId,
        venueId,
        slug: `event-${tag}-${run}`,
        name: `Event ${tag} ${run}`,
        startsAt: new Date("2026-11-21T00:00:00Z"),
        endsAt: new Date("2026-11-22T00:00:00Z"),
        status: "published",
        blockScope: "whole_day",
      })
      .returning({ id: schema.specialEvents.id });
    if (!event) throw new Error("event insert returned no row");
    return event.id;
  };

  const eventAId = await mkEvent(orgA.id, venueAId, "A");
  const eventBId = await mkEvent(orgB.id, venueBId, "B");

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
    eventAId,
    eventBId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    // Org cascade cleans venues → special_events.
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("special_events RLS cross-tenant isolation", () => {
  it("user A reads only their own event", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.specialEvents));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.eventAId);
    expect(ids).not.toContain(ctx.eventBId);
  });

  it("user B reads only their own event (mirror)", async () => {
    const rows = await asUser(ctx.userBId, (tx) => tx.select().from(schema.specialEvents));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.eventBId);
    expect(ids).not.toContain(ctx.eventAId);
  });

  it("authenticated role cannot insert an event directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.specialEvents).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          slug: `sneaky-${run}`,
          name: "Sneaky",
          startsAt: new Date("2026-12-01T00:00:00Z"),
          endsAt: new Date("2026-12-02T00:00:00Z"),
          status: "published",
          blockScope: "whole_day",
        }),
      ),
    ).rejects.toThrow();
  });
});
