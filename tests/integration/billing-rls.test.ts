// Integration tests for the billing tables (Phase: stripe-billing PR-1).
//
// Proves cross-tenant RLS on billing_subscriptions + billing_credit_ledger
// (org A cannot read org B's rows), that the authenticated role cannot
// write either table (no INSERT policy — all writes go through adminDb in
// the webhook), and the CHECK constraints + (reason, ref) idempotency key.

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
type Ctx = { userAId: string; userBId: string; orgAId: string; orgBId: string };
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
  const userAId = await mkUser(`bill-a-${run}@tablekit.test`);
  const userBId = await mkUser(`bill-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `BILL-A ${run}`, slug: `bill-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `BILL-B ${run}`, slug: `bill-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  // Seed one subscription + one ledger entry per org via adminDb (db).
  await db.insert(schema.billingSubscriptions).values([
    {
      organisationId: orgA.id,
      stripeSubscriptionId: `sub_a_${run}`,
      status: "active",
      plan: "plus",
    },
    {
      organisationId: orgB.id,
      stripeSubscriptionId: `sub_b_${run}`,
      status: "active",
      plan: "core",
    },
  ]);
  await db.insert(schema.billingCreditLedger).values([
    {
      organisationId: orgA.id,
      deltaPence: 2000,
      reason: "topup",
      ref: `pi_a_${run}`,
      balanceAfter: 2000,
    },
    {
      organisationId: orgB.id,
      deltaPence: 1000,
      reason: "topup",
      ref: `pi_b_${run}`,
      balanceAfter: 1000,
    },
  ]);

  ctx = { userAId, userBId, orgAId: orgA.id, orgBId: orgB.id };
});

afterAll(async () => {
  await db
    .delete(schema.organisations)
    .where(sql`${schema.organisations.id} in (${ctx.orgAId}, ${ctx.orgBId})`);
  await pool.end();
});

describe("billing_subscriptions RLS", () => {
  it("a member sees only their own org's subscription", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ org: schema.billingSubscriptions.organisationId })
        .from(schema.billingSubscriptions),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org).toBe(ctx.orgAId);
  });

  it("org B's subscription is invisible to user A even when filtered for", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ id: schema.billingSubscriptions.id })
        .from(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.organisationId, ctx.orgBId)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("billing_credit_ledger RLS", () => {
  it("a member sees only their own org's ledger entries", async () => {
    const rows = await asUser(ctx.userBId, (tx) =>
      tx
        .select({ org: schema.billingCreditLedger.organisationId })
        .from(schema.billingCreditLedger),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org).toBe(ctx.orgBId);
  });

  it("the authenticated role cannot INSERT (no write policy)", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.billingCreditLedger).values({
          organisationId: ctx.orgAId,
          deltaPence: 999,
          reason: "topup",
          ref: `pi_hack_${run}`,
          balanceAfter: 999,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("constraints", () => {
  it("rejects an unknown plan / reason via CHECK (even under adminDb)", async () => {
    await expect(
      db.insert(schema.billingSubscriptions).values({
        organisationId: ctx.orgAId,
        stripeSubscriptionId: `sub_bad_${run}`,
        status: "active",
        plan: "enterprise",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.billingCreditLedger).values({
        organisationId: ctx.orgAId,
        deltaPence: 1,
        reason: "bribe",
        ref: `x_${run}`,
        balanceAfter: 1,
      }),
    ).rejects.toThrow();
  });

  it("(reason, ref) is unique — a top-up applies at most once", async () => {
    await expect(
      db.insert(schema.billingCreditLedger).values({
        organisationId: ctx.orgAId,
        deltaPence: 2000,
        reason: "topup",
        ref: `pi_a_${run}`, // same (reason, ref) as the seeded orgA top-up
        balanceAfter: 4000,
      }),
    ).rejects.toThrow();
  });
});
