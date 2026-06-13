// Integration test for the Realtime spend channel's security posture.
//
// Supabase Realtime authorizes postgres_changes with the SAME RLS policy
// that guards REST reads. So "org A never receives org B's spend changes"
// reduces to two facts we can assert directly against the DB:
//   1. guest_spend_summary is published to supabase_realtime (so changes
//      stream at all);
//   2. the guest_spend_summary RLS policy denies a member of org A any
//      sight of org B's row — the exact predicate Realtime evaluates per
//      subscriber JWT.
// Full websocket delivery is exercised manually in staging; this locks the
// security contract in CI.

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
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
type Ctx = { userAId: string; userBId: string; orgAId: string; orgBId: string; guestBId: string };
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
  const userAId = await mkUser(`rt-a-${run}@tablekit.test`);
  const userBId = await mkUser(`rt-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `RT-A ${run}`, slug: `rt-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `RT-B ${run}`, slug: `rt-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA!.id, role: "owner" },
    { userId: userBId, organisationId: orgB!.id, role: "owner" },
  ]);

  const gB = await upsertGuest(orgB!.id, userBId, {
    firstName: "Rt",
    lastName: "Bravo",
    email: `rt-b-guest-${run}@example.com`,
  });
  if (!gB.ok) throw new Error("guest upsert failed");
  await db
    .insert(schema.guestSpendSummary)
    .values({
      guestId: gB.guestId,
      organisationId: orgB!.id,
      orderCount: 2,
      totalSpendMinor: 4000,
    });

  ctx = { userAId, userBId, orgAId: orgA!.id, orgBId: orgB!.id, guestBId: gB.guestId };
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

describe("Realtime spend channel — security contract", () => {
  it("guest_spend_summary is published to supabase_realtime", async () => {
    const res = await db.execute(
      sql`select 1 as ok from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'guest_spend_summary'`,
    );
    expect(res.rows.length).toBe(1);
  });

  it("org A cannot see org B's spend row (the predicate Realtime evaluates)", async () => {
    const rowsForA = await asUser(ctx.userAId, (tx) => tx.select().from(schema.guestSpendSummary));
    expect(rowsForA.map((r) => r.guestId)).not.toContain(ctx.guestBId);

    const rowsForB = await asUser(ctx.userBId, (tx) => tx.select().from(schema.guestSpendSummary));
    expect(rowsForB.map((r) => r.guestId)).toContain(ctx.guestBId);
  });
});
