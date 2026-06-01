// Integration tests for the marketing-campaign tables (Phase 3).
//
// Covers cross-tenant RLS on campaigns / campaign_sends / message_usage,
// the enforce-org triggers, CHECK constraints, and the idempotent
// fan-out unique key.

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
  guestAId: string;
  campaignAId: string;
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

  const userAId = await mkUser(`cmp-a-${run}@tablekit.test`);
  const userBId = await mkUser(`cmp-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `CMP-A ${run}`, slug: `cmp-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `CMP-B ${run}`, slug: `cmp-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "cafe" })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgA.id);
  const venueBId = await mkVenue(orgB.id);

  const [guestA] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgA.id,
      firstName: "Test",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `ch_${orgA.id}_${run}`,
    })
    .returning({ id: schema.guests.id });

  const [campA] = await db
    .insert(schema.campaigns)
    .values({
      organisationId: orgA.id,
      venueId: venueAId,
      name: "A",
      channel: "email",
      body: "Hi {{guestFirstName}}",
    })
    .returning({ id: schema.campaigns.id });
  await db.insert(schema.campaigns).values({
    organisationId: orgB.id,
    venueId: venueBId,
    name: "B",
    channel: "email",
    body: "x",
  });

  await db.insert(schema.campaignSends).values({
    organisationId: orgA.id,
    campaignId: campA!.id,
    guestId: guestA!.id,
    venueId: venueAId,
    channel: "email",
  });
  await db.insert(schema.messageUsage).values({
    organisationId: orgA.id,
    period: "2026-06",
    channel: "email",
    count: 3,
    estCostPence: 0,
  });
  await db.insert(schema.messageUsage).values({
    organisationId: orgB.id,
    period: "2026-06",
    channel: "sms",
    count: 1,
    estCostPence: 4,
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    guestAId: guestA!.id,
    campaignAId: campA!.id,
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

describe("campaigns — cross-tenant RLS", () => {
  it("user A sees only their org's campaigns / sends / usage", async () => {
    const rows = await asUser(ctx.userAId, async (tx) => ({
      campaigns: await tx.select().from(schema.campaigns),
      sends: await tx.select().from(schema.campaignSends),
      usage: await tx.select().from(schema.messageUsage),
    }));
    expect(rows.campaigns.map((r) => r.organisationId)).toContain(ctx.orgAId);
    expect(rows.campaigns.map((r) => r.organisationId)).not.toContain(ctx.orgBId);
    expect(rows.sends.every((r) => r.organisationId === ctx.orgAId)).toBe(true);
    expect(rows.usage.every((r) => r.organisationId === ctx.orgAId)).toBe(true);
  });

  it("authenticated cannot insert a campaign directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.campaigns).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          name: "hack",
          channel: "email",
          body: "x",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("enforce-org triggers", () => {
  it("rewrites a spoofed campaign org to the parent venue's org", async () => {
    const [row] = await db
      .insert(schema.campaigns)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: ctx.venueAId,
        name: "spoof",
        channel: "email",
        body: "x",
      })
      .returning({ id: schema.campaigns.id, organisationId: schema.campaigns.organisationId });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.campaigns).where(eq(schema.campaigns.id, row!.id));
  });

  it("rewrites a spoofed campaign_send org to the parent campaign's org", async () => {
    const [row] = await db
      .insert(schema.campaignSends)
      .values({
        organisationId: ctx.orgBId, // spoof
        campaignId: ctx.campaignAId,
        guestId: ctx.guestAId,
        venueId: ctx.venueAId,
        channel: "sms",
      })
      .returning({
        id: schema.campaignSends.id,
        organisationId: schema.campaignSends.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.campaignSends).where(eq(schema.campaignSends.id, row!.id));
  });
});

describe("constraints", () => {
  it("rejects an unknown campaign channel", async () => {
    await expect(
      db.insert(schema.campaigns).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        name: "bad",
        channel: "smoke-signal",
        body: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate (campaign, guest, channel) send", async () => {
    await expect(
      db.insert(schema.campaignSends).values({
        organisationId: ctx.orgAId,
        campaignId: ctx.campaignAId,
        guestId: ctx.guestAId,
        channel: "email",
        venueId: ctx.venueAId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate (org, period, channel) usage row", async () => {
    await expect(
      db.insert(schema.messageUsage).values({
        organisationId: ctx.orgAId,
        period: "2026-06",
        channel: "email",
        count: 1,
      }),
    ).rejects.toThrow();
  });
});
