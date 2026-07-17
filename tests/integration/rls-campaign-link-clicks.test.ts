// Integration tests for campaign_link_clicks (marketing-suite Phase C:
// link-level clicks). Proves rule-3 tenant isolation plus the four
// invariants the feature relies on:
//   1. enforce_campaign_link_clicks_org_id derives organisation_id from
//      the parent campaign (defence in depth — a mis-tenanted insert can't
//      land).
//   2. The unique (campaign_send_id, url) index dedupes repeat clicks, so
//      the report counts UNIQUE clickers per URL.
//   3. Deleting a campaign_send cascades to its link clicks — the reason
//      DSAR erasure + the retention sweep need no extra scrub path.
//   4. RLS: a member of org B never reads org A's link clicks.

import { and, eq, sql } from "drizzle-orm";
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
  campaignAId: string;
  sendA1Id: string;
  sendA2Id: string;
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
  const userAId = await mkUser(`clk-a-${run}@tablekit.test`);
  const userBId = await mkUser(`clk-b-${run}@tablekit.test`);

  const mkOrg = async (slug: string) => {
    const [o] = await db
      .insert(schema.organisations)
      .values({ name: slug, slug })
      .returning({ id: schema.organisations.id });
    return o!.id;
  };
  const orgAId = await mkOrg(`clk-a-${run}`);
  const orgBId = await mkOrg(`clk-b-${run}`);

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
  ]);

  const mkVenue = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "cafe" })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgAId);
  const venueBId = await mkVenue(orgBId);

  const mkGuest = async (orgId: string, suffix: string) => {
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "G",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `clk_${orgId}_${suffix}_${run}`,
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };

  const mkCampaign = async (orgId: string, venueId: string) => {
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        organisationId: orgId, // overwritten by enforce trigger
        venueId,
        name: "Promo",
        channel: "email",
        segment: "all",
        status: "sent",
        body: "Hi",
      })
      .returning({ id: schema.campaigns.id });
    return c!.id;
  };

  const mkSend = async (orgId: string, campaignId: string, venueId: string, guestId: string) => {
    const [s] = await db
      .insert(schema.campaignSends)
      .values({
        organisationId: orgId, // overwritten by enforce trigger
        campaignId,
        guestId,
        venueId,
        channel: "email",
        status: "delivered",
      })
      .returning({ id: schema.campaignSends.id });
    return s!.id;
  };

  const campaignAId = await mkCampaign(orgAId, venueAId);
  const gA1 = await mkGuest(orgAId, "1");
  const gA2 = await mkGuest(orgAId, "2");
  const sendA1Id = await mkSend(orgAId, campaignAId, venueAId, gA1);
  const sendA2Id = await mkSend(orgAId, campaignAId, venueAId, gA2);

  const campaignBId = await mkCampaign(orgBId, venueBId);
  const gB1 = await mkGuest(orgBId, "1");
  const sendB1Id = await mkSend(orgBId, campaignBId, venueBId, gB1);

  // Org B has a link click of its own (so the isolation test proves A
  // can't see B's data, not merely that B is empty).
  await db.insert(schema.campaignLinkClicks).values({
    organisationId: orgBId,
    campaignId: campaignBId,
    campaignSendId: sendB1Id,
    url: "https://book.tablekitapp.com/b",
  });

  ctx = { userAId, userBId, orgAId, campaignAId, sendA1Id, sendA2Id };
});

afterAll(async () => {
  await pool.end();
});

describe("campaign_link_clicks — enforce trigger", () => {
  it("derives organisation_id from the parent campaign, ignoring the supplied value", async () => {
    const [row] = await db
      .insert(schema.campaignLinkClicks)
      .values({
        organisationId: "00000000-0000-0000-0000-000000000000", // wrong on purpose
        campaignId: ctx.campaignAId,
        campaignSendId: ctx.sendA1Id,
        url: "https://book.tablekitapp.com/trigger-test",
      })
      .returning({ organisationId: schema.campaignLinkClicks.organisationId });
    expect(row!.organisationId).toBe(ctx.orgAId);
  });
});

describe("campaign_link_clicks — unique (send, url) dedup", () => {
  it("a repeat click on the same link is idempotent via onConflictDoNothing", async () => {
    const url = "https://book.tablekitapp.com/menu";
    const insertOnce = () =>
      db
        .insert(schema.campaignLinkClicks)
        .values({
          organisationId: ctx.orgAId,
          campaignId: ctx.campaignAId,
          campaignSendId: ctx.sendA1Id,
          url,
        })
        .onConflictDoNothing({
          target: [schema.campaignLinkClicks.campaignSendId, schema.campaignLinkClicks.url],
        });
    await insertOnce();
    await insertOnce(); // same send + url → no second row
    const rows = await db
      .select({ id: schema.campaignLinkClicks.id })
      .from(schema.campaignLinkClicks)
      .where(
        and(
          eq(schema.campaignLinkClicks.campaignSendId, ctx.sendA1Id),
          eq(schema.campaignLinkClicks.url, url),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

describe("campaign_link_clicks — top-links aggregation", () => {
  it("counts unique clickers per URL", async () => {
    // Same URL clicked by two different sends → 2 unique clickers.
    const url = "https://book.tablekitapp.com/event";
    for (const sendId of [ctx.sendA1Id, ctx.sendA2Id]) {
      await db.insert(schema.campaignLinkClicks).values({
        organisationId: ctx.orgAId,
        campaignId: ctx.campaignAId,
        campaignSendId: sendId,
        url,
      });
    }
    const [row] = await db
      .select({ clickers: sql<number>`count(*)::int` })
      .from(schema.campaignLinkClicks)
      .where(
        and(
          eq(schema.campaignLinkClicks.campaignId, ctx.campaignAId),
          eq(schema.campaignLinkClicks.url, url),
        ),
      );
    expect(row!.clickers).toBe(2);
  });
});

describe("campaign_link_clicks — FK cascade (DSAR / retention coverage)", () => {
  it("deleting a campaign_send removes its link clicks", async () => {
    // Use a throwaway send so we don't disturb the other tests.
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: ctx.orgAId,
        firstName: "G",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `clk_cascade_${run}`,
      })
      .returning({ id: schema.guests.id });
    const [venue] = await db
      .select({ id: schema.campaignSends.venueId })
      .from(schema.campaignSends)
      .where(eq(schema.campaignSends.id, ctx.sendA1Id))
      .limit(1);
    const [send] = await db
      .insert(schema.campaignSends)
      .values({
        organisationId: ctx.orgAId,
        campaignId: ctx.campaignAId,
        guestId: g!.id,
        venueId: venue!.id,
        channel: "email",
        status: "delivered",
      })
      .returning({ id: schema.campaignSends.id });
    await db.insert(schema.campaignLinkClicks).values({
      organisationId: ctx.orgAId,
      campaignId: ctx.campaignAId,
      campaignSendId: send!.id,
      url: "https://book.tablekitapp.com/cascade",
    });

    await db.delete(schema.campaignSends).where(eq(schema.campaignSends.id, send!.id));

    const orphans = await db
      .select({ id: schema.campaignLinkClicks.id })
      .from(schema.campaignLinkClicks)
      .where(eq(schema.campaignLinkClicks.campaignSendId, send!.id));
    expect(orphans).toHaveLength(0);
  });
});

describe("campaign_link_clicks — RLS isolation", () => {
  it("org A's member reads only org A's clicks; org B's are invisible", async () => {
    const aRows = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ orgId: schema.campaignLinkClicks.organisationId })
        .from(schema.campaignLinkClicks),
    );
    expect(aRows.length).toBeGreaterThan(0);
    expect(aRows.every((r) => r.orgId === ctx.orgAId)).toBe(true);

    // User B sees none of org A's clicks.
    const bSeesA = await asUser(ctx.userBId, (tx) =>
      tx
        .select({ id: schema.campaignLinkClicks.id })
        .from(schema.campaignLinkClicks)
        .where(eq(schema.campaignLinkClicks.campaignId, ctx.campaignAId)),
    );
    expect(bSeesA).toHaveLength(0);
  });
});
