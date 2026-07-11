// Integration tests for the marketing overview roll-up
// (docs/specs/marketing-suite.md, Part 2). Two tenants, each with an
// email campaign (sends + attributed bookings + consented guests) in the
// trailing window, plus an out-of-window campaign for org A that must be
// excluded. We run the overview queries under each user's RLS context and
// assert (a) the aggregates match the visible scope and (b) cross-tenant
// isolation holds — user A never sees org B's sends, bookings or list.

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getAudienceHealth,
  getChannelRollup,
  getMarketingOverview,
  getTopCampaigns,
  windowStart,
} from "@/lib/campaigns/overview";
import type { BookingStatus } from "@/lib/bookings/state";
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
const TZ = "Europe/London";

// Fixed "now" so window boundaries are deterministic regardless of wall
// clock. Campaigns are anchored relative to this.
const NOW = new Date("2026-07-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  recentCampaignAId: string;
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

  const userAId = await mkUser(`mkt-a-${run}@tablekit.test`);
  const userBId = await mkUser(`mkt-b-${run}@tablekit.test`);

  const mkOrg = async (label: string, slug: string) => {
    const [o] = await db
      .insert(schema.organisations)
      .values({ name: label, slug })
      .returning({ id: schema.organisations.id });
    return o!.id;
  };
  const orgAId = await mkOrg(`M-A ${run}`, `mkt-a-${run}`);
  const orgBId = await mkOrg(`M-B ${run}`, `mkt-b-${run}`);

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
  ]);

  const mkVenue = async (orgId: string, label: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: label, venueType: "cafe", timezone: TZ })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgAId, "VA");
  const venueBId = await mkVenue(orgBId, "VB");

  const mkArea = async (orgId: string, venueId: string) => {
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId, name: "Inside" })
      .returning({ id: schema.areas.id });
    return a!.id;
  };
  const areaAId = await mkArea(orgAId, venueAId);
  const areaBId = await mkArea(orgBId, venueBId);

  const schedule = {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "08:00",
    end: "22:00",
  };
  const mkService = async (orgId: string, venueId: string) => {
    const [s] = await db
      .insert(schema.services)
      .values({ organisationId: orgId, venueId, name: "Open", schedule, turnMinutes: 60 })
      .returning({ id: schema.services.id });
    return s!.id;
  };
  const serviceAId = await mkService(orgAId, venueAId);
  const serviceBId = await mkService(orgBId, venueBId);

  const mkGuest = async (
    orgId: string,
    suffix: string,
    consent: Partial<{ email: Date; sms: Date }> = {},
  ) => {
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "G",
        lastNameCipher: "c",
        emailCipher: "c",
        phoneCipher: "c",
        emailHash: `mkt_${orgId}_${suffix}_${run}`,
        marketingConsentEmailAt: consent.email,
        marketingConsentSmsAt: consent.sms,
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };

  // Org A audience:
  //  - 3 email-consented (2 opted-in long ago, 1 new inside the window)
  //  - 1 email-consented but unsubscribed from venue A
  //  - 1 SMS-only
  const gA1 = await mkGuest(orgAId, "e1", { email: daysAgo(200) });
  const gA2 = await mkGuest(orgAId, "e2", { email: daysAgo(200) });
  const gA3 = await mkGuest(orgAId, "e3new", { email: daysAgo(10) });
  const gAUnsub = await mkGuest(orgAId, "eunsub", { email: daysAgo(200) });
  await mkGuest(orgAId, "sms", { sms: daysAgo(5) });
  await db
    .update(schema.guests)
    .set({ emailUnsubscribedVenues: sql`ARRAY[${venueAId}::uuid]` })
    .where(sql`${schema.guests.id} = ${gAUnsub}`);

  const gB1 = await mkGuest(orgBId, "e1", { email: daysAgo(20) });

  const mkCampaign = async (orgId: string, venueId: string, name: string, sentAt: Date | null) => {
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        organisationId: orgId,
        venueId,
        name,
        channel: "email",
        segment: "all",
        status: sentAt ? "sent" : "draft",
        body: "Hi",
        sentAt,
      })
      .returning({ id: schema.campaigns.id });
    return c!.id;
  };

  const recentCampaignAId = await mkCampaign(orgAId, venueAId, "Recent A", daysAgo(5));
  const oldCampaignAId = await mkCampaign(orgAId, venueAId, "Old A", daysAgo(100));
  const campaignBId = await mkCampaign(orgBId, venueBId, "Recent B", daysAgo(5));

  const mkSend = async (
    orgId: string,
    campaignId: string,
    venueId: string,
    guestId: string,
    fields: Partial<{ status: string; openedAt: Date; clickedAt: Date }>,
  ) => {
    await db.insert(schema.campaignSends).values({
      organisationId: orgId, // overwritten by enforce trigger
      campaignId,
      guestId,
      venueId,
      channel: "email",
      status: fields.status ?? "delivered",
      sentAt: daysAgo(5),
      openedAt: fields.openedAt,
      clickedAt: fields.clickedAt,
    });
  };

  // Recent A: 3 delivered; 2 opened; 1 clicked.
  await mkSend(orgAId, recentCampaignAId, venueAId, gA1, {
    status: "delivered",
    openedAt: daysAgo(4),
    clickedAt: daysAgo(4),
  });
  await mkSend(orgAId, recentCampaignAId, venueAId, gA2, {
    status: "delivered",
    openedAt: daysAgo(4),
  });
  await mkSend(orgAId, recentCampaignAId, venueAId, gA3, { status: "delivered" });
  // Old A: 1 delivered — must be excluded from the window.
  await mkSend(orgAId, oldCampaignAId, venueAId, gAUnsub, { status: "delivered" });
  // Org B: 1 delivered.
  await mkSend(orgBId, campaignBId, venueBId, gB1, { status: "delivered", clickedAt: daysAgo(4) });

  const mkBooking = async (
    orgId: string,
    venueId: string,
    guestId: string,
    campaignId: string,
    fields: { partySize: number; status: BookingStatus; attributionKind: string },
  ) => {
    const areaId = orgId === orgAId ? areaAId : areaBId;
    const serviceId = orgId === orgAId ? serviceAId : serviceBId;
    await db.insert(schema.bookings).values({
      organisationId: orgId,
      venueId,
      serviceId,
      areaId,
      guestId,
      partySize: fields.partySize,
      startAt: daysAgo(2),
      endAt: new Date(daysAgo(2).getTime() + 60 * 60 * 1000),
      status: fields.status,
      source: "widget",
      campaignId,
      attributionKind: fields.attributionKind,
    });
  };

  // Recent A: 2 attributed bookings (party 2 + 3 = 5 covers) + 1 cancelled
  // (excluded). Old A: 1 booking — excluded via the campaign window.
  await mkBooking(orgAId, venueAId, gA1, recentCampaignAId, {
    partySize: 2,
    status: "confirmed",
    attributionKind: "link",
  });
  await mkBooking(orgAId, venueAId, gA2, recentCampaignAId, {
    partySize: 3,
    status: "finished",
    attributionKind: "click_window",
  });
  await mkBooking(orgAId, venueAId, gA3, recentCampaignAId, {
    partySize: 4,
    status: "cancelled",
    attributionKind: "link",
  });
  await mkBooking(orgAId, venueAId, gAUnsub, oldCampaignAId, {
    partySize: 9,
    status: "confirmed",
    attributionKind: "link",
  });
  // Org B: 1 attributed booking (party 6).
  await mkBooking(orgBId, venueBId, gB1, campaignBId, {
    partySize: 6,
    status: "confirmed",
    attributionKind: "link",
  });

  ctx = { userAId, userBId, orgAId, orgBId, venueAId, venueBId, recentCampaignAId };
});

afterAll(async () => {
  await pool.end();
});

describe("marketing overview — channel roll-up", () => {
  it("aggregates only in-window campaigns for the venue", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      getChannelRollup(tx, ctx.venueAId, windowStart(NOW)),
    );
    expect(rows).toHaveLength(1);
    const email = rows[0]!;
    expect(email.channel).toBe("email");
    expect(email.campaigns).toBe(1); // Old A excluded
    expect(email.sends).toBe(3);
    expect(email.delivered).toBe(3);
    expect(email.opened).toBe(2);
    expect(email.clicked).toBe(1);
    expect(email.bookings).toBe(2); // cancelled + old excluded
    expect(email.covers).toBe(5);
  });
});

describe("marketing overview — top campaigns", () => {
  it("ranks by booking conversion and excludes out-of-window", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      getTopCampaigns(tx, ctx.venueAId, windowStart(NOW)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(ctx.recentCampaignAId);
    expect(rows[0]!.bookings).toBe(2);
    expect(rows[0]!.delivered).toBe(3);
    expect(rows[0]!.conversion).toBeCloseTo(2 / 3, 5);
  });
});

describe("marketing overview — audience health", () => {
  it("counts consented, new opt-ins and unsubscribes per channel", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      getAudienceHealth(tx, ctx.venueAId, windowStart(NOW)),
    );
    const email = rows.find((r) => r.channel === "email")!;
    // gA1, gA2, gA3 reachable; gAUnsub excluded (opted out of venue A).
    expect(email.consented).toBe(3);
    expect(email.newOptIns).toBe(1); // gA3 only
    expect(email.unsubscribed).toBe(1); // gAUnsub
    expect(email.unsubRate).toBeCloseTo(1 / 4, 5);

    const smsRow = rows.find((r) => r.channel === "sms")!;
    expect(smsRow.consented).toBe(1);
    expect(smsRow.newOptIns).toBe(1);
  });
});

describe("marketing overview — cross-tenant isolation", () => {
  it("user A never sees org B's campaigns, sends or bookings", async () => {
    const a = await asUser(ctx.userAId, (tx) => getMarketingOverview(tx, ctx.venueAId, NOW));
    // Org A totals only.
    expect(a.channels[0]!.bookings).toBe(2);
    expect(a.channels[0]!.covers).toBe(5);
    // Querying org B's venue under user A's RLS context yields no campaign
    // or booking data — those are venue + RLS scoped.
    const aOnB = await asUser(ctx.userAId, (tx) => getMarketingOverview(tx, ctx.venueBId, NOW));
    expect(aOnB.channels).toHaveLength(0);
    expect(aOnB.topCampaigns).toHaveLength(0);
    // Audience health is org-scoped (consent lives on the guest at org
    // level; only opt-out is per-venue — mirrors audiencePredicate). So
    // passing venue B's id still reflects ORG A's own guests, never org
    // B's single guest — proving RLS blocks org B's rows. All 4 of org A's
    // email-consented guests count here (gAUnsub opted out of venue A, not
    // B), vs 3 when scoped to venue A above.
    const emailOnB = aOnB.audience.find((r) => r.channel === "email")!;
    expect(emailOnB.consented).toBe(4);
  });

  it("user B sees only org B", async () => {
    const b = await asUser(ctx.userBId, (tx) => getMarketingOverview(tx, ctx.venueBId, NOW));
    expect(b.channels).toHaveLength(1);
    expect(b.channels[0]!.covers).toBe(6);
    expect(b.channels[0]!.clicked).toBe(1);
  });
});
