// Integration tests for the ai_usage ledger (docs/specs/ai-usage.md).
//
// Covers:
//   1. Cross-tenant RLS — org A's member reads its own ledger rows and
//      zero of org B's (CLAUDE.md rule 3).
//   2. recordAiUsage upsert — first call inserts, second call
//      increments (call_count + token sums) on the same
//      (org, period, venue) row; a different period opens a new row.

import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordAiUsage } from "@/lib/billing/ai-usage";
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
const JUNE = new Date("2026-06-10T12:00:00Z");
const JULY = new Date("2026-07-10T12:00:00Z");

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
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
  const userAId = await mkUser(`ai-usage-a-${run}@tablekit.test`);
  const userBId = await mkUser(`ai-usage-b-${run}@tablekit.test`);

  const mkOrg = async (tag: string) => {
    const [o] = await db
      .insert(schema.organisations)
      .values({ name: `AIU ${tag} ${run}`, slug: `ai-usage-${tag}-${run}`, plan: "plus" })
      .returning({ id: schema.organisations.id });
    return o!.id;
  };
  const orgAId = await mkOrg("a");
  const orgBId = await mkOrg("b");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
  ]);

  const mkVenue = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "cafe", timezone: "Europe/London" })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgAId);
  const venueBId = await mkVenue(orgBId);

  ctx = { userAId, userBId, orgAId, orgBId, venueAId, venueBId };

  await recordAiUsage({
    organisationId: orgAId,
    venueId: venueAId,
    usage: { inputTokens: 900, outputTokens: 150 },
    now: JUNE,
  });
  await recordAiUsage({
    organisationId: orgBId,
    venueId: venueBId,
    usage: { inputTokens: 500, outputTokens: 100 },
    now: JUNE,
  });
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

describe("ai_usage RLS", () => {
  it("member reads own org's ledger rows", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx.select().from(schema.aiUsage).where(eq(schema.aiUsage.organisationId, ctx.orgAId)),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("cross-tenant: org A member sees zero of org B's rows", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx.select().from(schema.aiUsage).where(eq(schema.aiUsage.organisationId, ctx.orgBId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("RLS blocks member INSERT (writes are adminDb-only)", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.aiUsage).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          period: "2026-06",
          callCount: 1,
          inputTokens: 1,
          outputTokens: 1,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("recordAiUsage upsert", () => {
  it("increments the same (org, period, venue) row", async () => {
    await recordAiUsage({
      organisationId: ctx.orgAId,
      venueId: ctx.venueAId,
      usage: { inputTokens: 100, outputTokens: 50 },
      now: JUNE,
    });
    const [row] = await db
      .select()
      .from(schema.aiUsage)
      .where(
        and(
          eq(schema.aiUsage.organisationId, ctx.orgAId),
          eq(schema.aiUsage.venueId, ctx.venueAId),
          eq(schema.aiUsage.period, "2026-06"),
        ),
      );
    expect(row?.callCount).toBe(2);
    expect(row?.inputTokens).toBe(1000);
    expect(row?.outputTokens).toBe(200);
  });

  it("a new period opens a new row", async () => {
    await recordAiUsage({
      organisationId: ctx.orgAId,
      venueId: ctx.venueAId,
      usage: { inputTokens: 10, outputTokens: 5 },
      now: JULY,
    });
    const rows = await db
      .select()
      .from(schema.aiUsage)
      .where(
        and(
          eq(schema.aiUsage.organisationId, ctx.orgAId),
          eq(schema.aiUsage.venueId, ctx.venueAId),
        ),
      );
    const periods = rows.map((r) => r.period).sort();
    expect(periods).toEqual(["2026-06", "2026-07"]);
  });
});
