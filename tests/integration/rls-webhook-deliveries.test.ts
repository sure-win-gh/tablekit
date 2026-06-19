// Integration tests for webhook_deliveries RLS (security audit P2 watch
// item — migration 0033 loosened the deny-all policy to a member-read
// policy; this proves the read stays org-scoped and writes stay denied).
//
// Covers (CLAUDE.md rule 3 — every org-scoped table ships an RLS test):
//   1. Cross-tenant RLS — owner A sees only org A's delivery rows, never
//      org B's, through the `webhook_deliveries_member_read` policy.
//   2. Deny-by-default writes — authenticated cannot INSERT a delivery
//      (all writes flow via adminDb from the verified dispatcher/cron).
//
// webhook_deliveries has no org-id rewrite trigger (organisation_id is
// denormalised from the subscription at insert by adminDb), so there is
// no spoof-correction case to assert here — unlike the POS tables.

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
  ownerAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  subAId: string;
  subBId: string;
  deliveryAId: string;
  deliveryBId: string;
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

  const ownerAId = await mkUser(`wd-owner-a-${run}@tablekit.test`);
  const userBId = await mkUser(`wd-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `WD-A ${run}`, slug: `wd-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `WD-B ${run}`, slug: `wd-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: ownerAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkSub = async (orgId: string) => {
    const [s] = await db
      .insert(schema.webhookSubscriptions)
      .values({
        organisationId: orgId,
        url: "https://example.test/hook",
        label: "Test sub",
        secretCipher: "cipher-placeholder",
        events: ["booking.created"],
      })
      .returning({ id: schema.webhookSubscriptions.id });
    return s!.id;
  };
  const subAId = await mkSub(orgA.id);
  const subBId = await mkSub(orgB.id);

  const mkDelivery = async (orgId: string, subId: string, ext: string) => {
    const [d] = await db
      .insert(schema.webhookDeliveries)
      .values({
        organisationId: orgId,
        subscriptionId: subId,
        eventType: "booking.created",
        eventId: `booking.created:${ext}`,
        payload: { booking_id: ext },
      })
      .returning({ id: schema.webhookDeliveries.id });
    return d!.id;
  };
  const deliveryAId = await mkDelivery(orgA.id, subAId, `a-${run}`);
  const deliveryBId = await mkDelivery(orgB.id, subBId, `b-${run}`);

  ctx = {
    ownerAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    subAId,
    subBId,
    deliveryAId,
    deliveryBId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.ownerAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("webhook_deliveries — cross-tenant RLS", () => {
  it("owner A sees only org A's deliveries", async () => {
    const rows = await asUser(ctx.ownerAId, (tx) => tx.select().from(schema.webhookDeliveries));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.deliveryAId);
    expect(ids).not.toContain(ctx.deliveryBId);
    expect(rows.every((r) => r.organisationId === ctx.orgAId)).toBe(true);
  });

  it("owner B sees only org B's deliveries", async () => {
    const rows = await asUser(ctx.userBId, (tx) => tx.select().from(schema.webhookDeliveries));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.deliveryBId);
    expect(ids).not.toContain(ctx.deliveryAId);
  });
});

describe("webhook_deliveries — deny-by-default writes", () => {
  it("authenticated cannot insert a delivery", async () => {
    await expect(
      asUser(ctx.ownerAId, (tx) =>
        tx.insert(schema.webhookDeliveries).values({
          organisationId: ctx.orgAId,
          subscriptionId: ctx.subAId,
          eventType: "booking.created",
          eventId: `hack-${run}`,
          payload: { booking_id: "hack" },
        }),
      ),
    ).rejects.toThrow();
  });
});
