// Integration tests for Phase 4 guest segments.
//
// Seeds guests with distinct visit histories + tags and asserts each
// built-in segment resolves to the expected set, that segmentSizes
// counts match, and that narrowing a campaign audience by segment still
// honours the marketing-consent gate (segment narrows WITHIN consent,
// never around it).

import { sql, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { audiencePredicate } from "@/lib/campaigns/recipients";
import { segmentPredicate, segmentSizes } from "@/lib/guests/segments";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);
const NOW = new Date();

type Ctx = {
  userId: string;
  orgId: string;
  venueId: string;
  gNew: string;
  gRegular: string;
  gLapsed: string;
  gVip: string;
  gNoConsent: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `seg-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const userId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `SEG ${run}`, slug: `seg-${run}` })
    .returning({ id: schema.organisations.id });
  await db.insert(schema.memberships).values({ userId, organisationId: org!.id, role: "owner" });

  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: org!.id, name: "V", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: org!.id, venueId: venue!.id, name: "In" })
    .returning({ id: schema.areas.id });
  const [service] = await db
    .insert(schema.services)
    .values({
      organisationId: org!.id,
      venueId: venue!.id,
      name: "Open",
      schedule: { days: ["mon"], start: "08:00", end: "17:00" },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });

  let n = 0;
  const mkGuest = async (opts: { consent: boolean; tags?: string[] }) => {
    n += 1;
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: org!.id,
        firstName: "G",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `seg_${run}_${n}`,
        tags: opts.tags ?? [],
        ...(opts.consent ? { marketingConsentEmailAt: NOW } : {}),
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };

  const mkBooking = async (guestId: string, daysAgo: number) => {
    await db.insert(schema.bookings).values({
      organisationId: org!.id,
      venueId: venue!.id,
      serviceId: service!.id,
      areaId: area!.id,
      guestId,
      partySize: 2,
      startAt: sql`now() - make_interval(days => ${daysAgo})`,
      endAt: sql`now() - make_interval(days => ${daysAgo}) + interval '60 minutes'`,
      status: "finished",
      source: "host",
    });
  };

  const gNew = await mkGuest({ consent: true });
  await mkBooking(gNew, 2);

  const gRegular = await mkGuest({ consent: true });
  await mkBooking(gRegular, 2);
  await mkBooking(gRegular, 5);
  await mkBooking(gRegular, 9);

  const gLapsed = await mkGuest({ consent: true });
  await mkBooking(gLapsed, 100);
  await mkBooking(gLapsed, 130);

  const gVip = await mkGuest({ consent: true, tags: ["VIP"] });
  await mkBooking(gVip, 2);
  await mkBooking(gVip, 4);

  const gNoConsent = await mkGuest({ consent: false });
  await mkBooking(gNoConsent, 2);

  ctx = {
    userId,
    orgId: org!.id,
    venueId: venue!.id,
    gNew,
    gRegular,
    gLapsed,
    gVip,
    gNoConsent,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

async function guestsMatching(
  predicate: ReturnType<typeof audiencePredicate>,
): Promise<Set<string>> {
  const rows = await db.select({ id: schema.guests.id }).from(schema.guests).where(predicate);
  return new Set(rows.map((r) => r.id));
}

async function segmentMembers(segment: "new" | "regular" | "lapsed" | "vip"): Promise<Set<string>> {
  const pred = sql`${schema.guests.organisationId} = ${ctx.orgId}::uuid and ${segmentPredicate(ctx.venueId, segment, NOW)!}`;
  const rows = await db.select({ id: schema.guests.id }).from(schema.guests).where(pred);
  return new Set(rows.map((r) => r.id));
}

describe("segmentPredicate", () => {
  it("new = exactly one realised visit", async () => {
    const m = await segmentMembers("new");
    expect(m.has(ctx.gNew)).toBe(true);
    expect(m.has(ctx.gNoConsent)).toBe(true); // 1 visit, consent-agnostic at this layer
    expect(m.has(ctx.gRegular)).toBe(false);
    expect(m.has(ctx.gLapsed)).toBe(false);
  });

  it("regular = 3+ realised visits", async () => {
    const m = await segmentMembers("regular");
    expect(m.has(ctx.gRegular)).toBe(true);
    expect(m.has(ctx.gNew)).toBe(false);
    expect(m.has(ctx.gVip)).toBe(false);
  });

  it("lapsed = last visit > 90 days ago", async () => {
    const m = await segmentMembers("lapsed");
    expect(m.has(ctx.gLapsed)).toBe(true);
    expect(m.has(ctx.gRegular)).toBe(false);
    expect(m.has(ctx.gVip)).toBe(false);
  });

  it("vip = carries the vip tag (case-insensitive)", async () => {
    const m = await segmentMembers("vip");
    expect(m.has(ctx.gVip)).toBe(true);
    expect(m.has(ctx.gNew)).toBe(false);
  });
});

describe("segmentSizes", () => {
  it("counts each segment over the org guest base", async () => {
    const sizes = await segmentSizes(db, ctx.orgId, ctx.venueId, NOW);
    expect(sizes.all).toBe(5);
    expect(sizes.new).toBe(2); // gNew + gNoConsent
    expect(sizes.regular).toBe(1);
    expect(sizes.lapsed).toBe(1);
    expect(sizes.vip).toBe(1);
  });
});

describe("campaign audience narrowing keeps the consent gate", () => {
  it("segment all = consented guests only (gNoConsent excluded)", async () => {
    const m = await guestsMatching(
      audiencePredicate(ctx.orgId, ctx.venueId, "email", { segment: "all", now: NOW }),
    );
    expect(m).toEqual(new Set([ctx.gNew, ctx.gRegular, ctx.gLapsed, ctx.gVip]));
  });

  it("segment regular = only the consented regular", async () => {
    const m = await guestsMatching(
      audiencePredicate(ctx.orgId, ctx.venueId, "email", { segment: "regular", now: NOW }),
    );
    expect(m).toEqual(new Set([ctx.gRegular]));
  });

  it("segment new excludes the unconsented one-visit guest", async () => {
    const m = await guestsMatching(
      audiencePredicate(ctx.orgId, ctx.venueId, "email", { segment: "new", now: NOW }),
    );
    expect(m).toEqual(new Set([ctx.gNew])); // gNoConsent has 1 visit but no consent
  });
});
