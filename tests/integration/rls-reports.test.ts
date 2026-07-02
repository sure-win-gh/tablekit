// Integration tests for the reporting module.
//
// Two tenants, both with bookings + payments (and reviews + POS
// orders) on the same date. We run every report query under each
// user's RLS context and
// assert (a) the aggregates are correct for the visible scope and
// (b) cross-tenant isolation holds — user A never sees a booking
// or payment from org B.

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BookingStatus } from "@/lib/bookings/state";
import * as schema from "@/lib/db/schema";
import { getCancellationsReport } from "@/lib/reports/cancellations";
import { getCoversReport } from "@/lib/reports/covers";
import { getDepositRevenueReport } from "@/lib/reports/deposits";
import { parseFilter } from "@/lib/reports/filter";
import { getNoShowReport } from "@/lib/reports/no-show";
import { getOccupancyReport } from "@/lib/reports/occupancy";
import { getPeakTimesReport } from "@/lib/reports/peak-times";
import { getReviewsReport } from "@/lib/reports/reviews";
import { getSourceMixReport } from "@/lib/reports/sources";
import { getSpendReport } from "@/lib/reports/spend";
import { getTopGuestsReport } from "@/lib/reports/top-guests";

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
// Mid-May 2026, BST. Pick a Monday + Tuesday for two-day rollups.
const DAY1_LOCAL = "2026-05-11"; // Monday
const DAY2_LOCAL = "2026-05-12"; // Tuesday
const TZ = "Europe/London";

// 12:00 BST → 11:00 UTC.
const at = (ymd: string, wallHour: number) =>
  new Date(`${ymd}T${String(wallHour - 1).padStart(2, "0")}:00:00Z`);

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  serviceALunchId: string;
  serviceADinnerId: string;
  serviceBId: string;
  guestAReturnId: string;
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

  const userAId = await mkUser(`rep-a-${run}@tablekit.test`);
  const userBId = await mkUser(`rep-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `R-A ${run}`, slug: `rep-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `R-B ${run}`, slug: `rep-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string, label: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: label, venueType: "cafe", timezone: TZ })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgA.id, "VA");
  const venueBId = await mkVenue(orgB.id, "VB");

  const mkArea = async (orgId: string, venueId: string) => {
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId, name: "Inside" })
      .returning({ id: schema.areas.id });
    return a!.id;
  };
  const areaAId = await mkArea(orgA.id, venueAId);
  const areaBId = await mkArea(orgB.id, venueBId);

  const schedule = {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "08:00",
    end: "22:00",
  };
  const mkService = async (orgId: string, venueId: string, name: string) => {
    const [s] = await db
      .insert(schema.services)
      .values({ organisationId: orgId, venueId, name, schedule, turnMinutes: 60 })
      .returning({ id: schema.services.id });
    return s!.id;
  };
  const serviceALunchId = await mkService(orgA.id, venueAId, "Lunch");
  const serviceADinnerId = await mkService(orgA.id, venueAId, "Dinner");
  const serviceBId = await mkService(orgB.id, venueBId, "Open");

  const mkGuest = async (orgId: string, hashSuffix: string, firstName = "Test") => {
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName,
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `hash_${orgId}_${hashSuffix}_${run}`,
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };

  const guestAReturnId = await mkGuest(orgA.id, "return", "Returner");
  const guestAOnceId = await mkGuest(orgA.id, "once");
  const guestBId = await mkGuest(orgB.id, "b");

  const mkBooking = async (input: {
    orgId: string;
    venueId: string;
    serviceId: string;
    areaId: string;
    guestId: string;
    partySize: number;
    startAt: Date;
    endAt: Date;
    status: BookingStatus;
    source: string;
  }) => {
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: input.orgId,
        venueId: input.venueId,
        serviceId: input.serviceId,
        areaId: input.areaId,
        guestId: input.guestId,
        partySize: input.partySize,
        startAt: input.startAt,
        endAt: input.endAt,
        status: input.status,
        source: input.source,
      })
      .returning({ id: schema.bookings.id });
    return b!.id;
  };

  // Org A — DAY1 lunch: 2 confirmed (party 2 + 4), 1 cancelled (party 3),
  //                   dinner: 1 finished (party 6), 1 no_show (party 2).
  //         DAY2 lunch: 1 finished (party 2, returning guest).
  const seedA = async () => [
    await mkBooking({
      orgId: orgA.id,
      venueId: venueAId,
      serviceId: serviceALunchId,
      areaId: areaAId,
      guestId: guestAReturnId,
      partySize: 2,
      startAt: at(DAY1_LOCAL, 12),
      endAt: at(DAY1_LOCAL, 13),
      status: "confirmed",
      source: "host",
    }),
    await mkBooking({
      orgId: orgA.id,
      venueId: venueAId,
      serviceId: serviceALunchId,
      areaId: areaAId,
      guestId: guestAOnceId,
      partySize: 4,
      startAt: at(DAY1_LOCAL, 13),
      endAt: at(DAY1_LOCAL, 14),
      status: "confirmed",
      source: "widget",
    }),
    await mkBooking({
      orgId: orgA.id,
      venueId: venueAId,
      serviceId: serviceALunchId,
      areaId: areaAId,
      guestId: guestAOnceId,
      partySize: 3,
      startAt: at(DAY1_LOCAL, 14),
      endAt: at(DAY1_LOCAL, 15),
      status: "cancelled",
      source: "widget",
    }),
    await mkBooking({
      orgId: orgA.id,
      venueId: venueAId,
      serviceId: serviceADinnerId,
      areaId: areaAId,
      guestId: guestAReturnId,
      partySize: 6,
      startAt: at(DAY1_LOCAL, 19),
      endAt: at(DAY1_LOCAL, 20),
      status: "finished",
      source: "host",
    }),
    await mkBooking({
      orgId: orgA.id,
      venueId: venueAId,
      serviceId: serviceADinnerId,
      areaId: areaAId,
      guestId: guestAOnceId,
      partySize: 2,
      startAt: at(DAY1_LOCAL, 20),
      endAt: at(DAY1_LOCAL, 21),
      status: "no_show",
      source: "host",
    }),
    await mkBooking({
      orgId: orgA.id,
      venueId: venueAId,
      serviceId: serviceALunchId,
      areaId: areaAId,
      guestId: guestAReturnId,
      partySize: 2,
      startAt: at(DAY2_LOCAL, 13),
      endAt: at(DAY2_LOCAL, 14),
      status: "finished",
      source: "widget",
    }),
  ];
  const bookingAIds = await seedA();
  const bookingAFinishedDinner = bookingAIds[3]!;
  const bookingANoShow = bookingAIds[4]!;
  const bookingACancelled = bookingAIds[2]!;

  // Cancellation reason on org A's cancelled booking — feeds the
  // cancellations report's by-reason breakdown.
  await db
    .update(schema.bookings)
    .set({ cancelledAt: at(DAY1_LOCAL, 10), cancelledReason: "change_of_plans" })
    .where(eq(schema.bookings.id, bookingACancelled));

  // A 10-top table for venue A so occupancy has non-zero capacity.
  await db.insert(schema.venueTables).values({
    organisationId: orgA.id,
    venueId: venueAId,
    areaId: areaAId,
    label: "T1",
    minCover: 1,
    maxCover: 10,
  });

  // Org B — one confirmed booking on DAY1 with a deposit. RLS check
  // will assert user A *cannot* see it.
  const bookingBId = await mkBooking({
    orgId: orgB.id,
    venueId: venueBId,
    serviceId: serviceBId,
    areaId: areaBId,
    guestId: guestBId,
    partySize: 5,
    startAt: at(DAY1_LOCAL, 12),
    endAt: at(DAY1_LOCAL, 13),
    status: "confirmed",
    source: "widget",
  });

  // Payments — Org A: deposit on dinner-finished (£20), refund (£5),
  //                   no-show capture on no-show booking (£20).
  //            Org B: deposit (£10).
  await db.insert(schema.payments).values([
    {
      organisationId: orgA.id,
      bookingId: bookingAFinishedDinner,
      kind: "deposit",
      stripeIntentId: `pi_a_dep_${run}`,
      amountMinor: 2000,
      currency: "GBP",
      status: "succeeded",
    },
    {
      organisationId: orgA.id,
      bookingId: bookingAFinishedDinner,
      kind: "refund",
      stripeIntentId: `re_a_${run}`,
      // Refunds are stored negative — see payments_amount_sign_check.
      amountMinor: -500,
      currency: "GBP",
      status: "succeeded",
    },
    {
      organisationId: orgA.id,
      bookingId: bookingANoShow,
      kind: "no_show_capture",
      stripeIntentId: `pi_a_ns_${run}`,
      amountMinor: 2000,
      currency: "GBP",
      status: "succeeded",
    },
    {
      organisationId: orgB.id,
      bookingId: bookingBId,
      kind: "deposit",
      stripeIntentId: `pi_b_dep_${run}`,
      amountMinor: 1000,
      currency: "GBP",
      status: "succeeded",
    },
  ]);

  // Reviews — org A: two reviews in range (internal + google); org B:
  // one. The RLS check asserts user A can't see org B's.
  await db.insert(schema.reviews).values([
    {
      organisationId: orgA.id,
      venueId: venueAId,
      bookingId: bookingAFinishedDinner,
      guestId: guestAReturnId,
      rating: 5,
      source: "internal",
      submittedAt: at(DAY1_LOCAL, 21),
    },
    {
      organisationId: orgA.id,
      venueId: venueAId,
      rating: 3,
      source: "google",
      externalId: `g_${run}`,
      // External reviews require a display name per reviews_source_shape_check.
      reviewerDisplayName: "A. Diner",
      submittedAt: at(DAY2_LOCAL, 14),
    },
    {
      organisationId: orgB.id,
      venueId: venueBId,
      rating: 1,
      source: "internal",
      bookingId: bookingBId,
      guestId: guestBId,
      submittedAt: at(DAY1_LOCAL, 21),
    },
  ]);

  // POS — one connection + two orders for org A (one with covers, one
  // without), one order for org B.
  const mkPosConnection = async (orgId: string, venueId: string) => {
    const [c] = await db
      .insert(schema.posConnections)
      .values({ organisationId: orgId, venueId, provider: "generic" })
      .returning({ id: schema.posConnections.id });
    return c!.id;
  };
  const posConnAId = await mkPosConnection(orgA.id, venueAId);
  const posConnBId = await mkPosConnection(orgB.id, venueBId);
  await db.insert(schema.posOrders).values([
    {
      organisationId: orgA.id,
      venueId: venueAId,
      connectionId: posConnAId,
      provider: "generic",
      externalOrderId: `oa1_${run}`,
      totalMinor: 5000,
      coverCount: 2,
      closedAt: at(DAY1_LOCAL, 14),
    },
    {
      organisationId: orgA.id,
      venueId: venueAId,
      connectionId: posConnAId,
      provider: "generic",
      externalOrderId: `oa2_${run}`,
      totalMinor: 3000,
      coverCount: null,
      closedAt: at(DAY2_LOCAL, 14),
    },
    {
      organisationId: orgB.id,
      venueId: venueBId,
      connectionId: posConnBId,
      provider: "generic",
      externalOrderId: `ob1_${run}`,
      totalMinor: 9999,
      coverCount: 4,
      closedAt: at(DAY1_LOCAL, 14),
    },
  ]);

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
    serviceALunchId,
    serviceADinnerId,
    serviceBId,
    guestAReturnId,
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

const filter = () => {
  const r = parseFilter({
    venueId: "ignored",
    fromDate: DAY1_LOCAL,
    toDate: DAY2_LOCAL,
    timezone: TZ,
  });
  if (!r.ok) throw new Error("filter parse failed");
  return r.bounds;
};

describe("reports — covers", () => {
  it("aggregates per-day-per-service for venue A", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) => getCoversReport(tx, ctx.venueAId, bounds));
    // Expected: DAY1 Lunch (3 bookings, 9 booked, 6 realised),
    //           DAY1 Dinner (2, 8, 6),
    //           DAY2 Lunch (1, 2, 2).
    const byKey = new Map(rows.map((r) => [`${r.day}|${r.serviceName}`, r]));
    const day1Lunch = byKey.get(`${DAY1_LOCAL}|Lunch`);
    expect(day1Lunch?.bookings).toBe(3);
    expect(day1Lunch?.coversBooked).toBe(9);
    expect(day1Lunch?.coversRealised).toBe(6);
    const day1Dinner = byKey.get(`${DAY1_LOCAL}|Dinner`);
    expect(day1Dinner?.bookings).toBe(2);
    expect(day1Dinner?.coversBooked).toBe(8);
    expect(day1Dinner?.coversRealised).toBe(6);
    const day2Lunch = byKey.get(`${DAY2_LOCAL}|Lunch`);
    expect(day2Lunch?.bookings).toBe(1);
    expect(day2Lunch?.coversRealised).toBe(2);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) => getCoversReport(tx, ctx.venueBId, bounds));
    expect(rows).toEqual([]);
  });
});

describe("reports — no-show", () => {
  it("computes overall + with-deposit rates", async () => {
    const bounds = filter();
    const summary = await asUser(ctx.userAId, (tx) => getNoShowReport(tx, ctx.venueAId, bounds));
    // Eligible (confirmed/seated/finished/no_show): 2 confirmed, 1
    // finished day1, 1 no_show, 1 finished day2 = 5. No-shows = 1.
    expect(summary.totalEligible).toBe(5);
    expect(summary.totalNoShows).toBe(1);
    expect(summary.rate).toBeCloseTo(0.2, 5);
    // With-deposit cohort = bookings with succeeded deposit/hold
    // payment. Only the dinner-finished booking has a deposit (the
    // no-show has a no_show_capture payment, which doesn't count for
    // the with-deposit cohort).
    expect(summary.withDepositEligible).toBe(1);
    expect(summary.withDepositNoShows).toBe(0);
  });
});

describe("reports — deposits", () => {
  it("nets deposits + no-show captures − refunds for venue A", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) =>
      getDepositRevenueReport(tx, ctx.venueAId, bounds),
    );
    // Both payments on day1 (dinner-finished + no-show), so a single
    // day1 row: collected=2000, no_show=2000, refunded=500, net=3500.
    const day1 = rows.find((r) => r.day === DAY1_LOCAL);
    expect(day1?.depositsCollectedMinor).toBe(2000);
    expect(day1?.noShowCapturedMinor).toBe(2000);
    expect(day1?.refundedMinor).toBe(500);
    expect(day1?.netMinor).toBe(3500);
  });

  it("user A querying venue B's id sees no payment rows — RLS", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) =>
      getDepositRevenueReport(tx, ctx.venueBId, bounds),
    );
    expect(rows).toEqual([]);
  });
});

describe("reports — sources", () => {
  it("groups + counts bookings.source for venue A", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) => getSourceMixReport(tx, ctx.venueAId, bounds));
    const bySource = new Map(rows.map((r) => [r.source, r]));
    // 3 host (lunch confirmed + dinner finished + dinner no_show),
    // 3 widget (lunch confirmed + lunch cancelled + day2 finished).
    expect(bySource.get("host")?.bookings).toBe(3);
    expect(bySource.get("widget")?.bookings).toBe(3);
  });
});

describe("reports — top guests", () => {
  it("returns guests with 2+ realised visits", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) => getTopGuestsReport(tx, ctx.venueAId, bounds));
    // Returner: confirmed lunch day1 + finished dinner day1 + finished
    // lunch day2 = 3 realised visits. Once-guest: only confirmed
    // counts (the cancelled and no_show don't); they have 1 confirmed
    // (lunch day1), which fails the >=2 having clause.
    const returner = rows.find((r) => r.guestId === ctx.guestAReturnId);
    expect(returner?.visits).toBe(3);
    expect(rows.length).toBe(1);
  });
});

describe("reports — cancellations", () => {
  it("computes rate + reason breakdown for venue A", async () => {
    const bounds = filter();
    const report = await asUser(ctx.userAId, (tx) =>
      getCancellationsReport(tx, ctx.venueAId, bounds),
    );
    // 6 bookings in range, 1 cancelled (reason change_of_plans).
    expect(report.totalBookings).toBe(6);
    expect(report.cancelled).toBe(1);
    expect(report.rate).toBeCloseTo(1 / 6, 5);
    expect(report.byReason).toEqual([{ reason: "change_of_plans", count: 1 }]);
    const day1 = report.byDay.find((r) => r.day === DAY1_LOCAL);
    expect(day1?.bookings).toBe(5);
    expect(day1?.cancelled).toBe(1);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const bounds = filter();
    const report = await asUser(ctx.userAId, (tx) =>
      getCancellationsReport(tx, ctx.venueBId, bounds),
    );
    expect(report.totalBookings).toBe(0);
    expect(report.byReason).toEqual([]);
  });
});

describe("reports — peak times", () => {
  it("buckets realised covers by venue-local weekday × hour", async () => {
    const bounds = filter();
    const cells = await asUser(ctx.userAId, (tx) => getPeakTimesReport(tx, ctx.venueAId, bounds));
    const byKey = new Map(cells.map((c) => [`${c.weekday}-${c.hour}`, c]));
    // DAY1 (Monday, isodow 1): 12:00 party 2, 13:00 party 4, 19:00
    // party 6. The 14:00 cancelled and 20:00 no_show are excluded.
    expect(byKey.get("1-12")?.covers).toBe(2);
    expect(byKey.get("1-13")?.covers).toBe(4);
    expect(byKey.get("1-19")?.covers).toBe(6);
    expect(byKey.get("1-14")).toBeUndefined();
    expect(byKey.get("1-20")).toBeUndefined();
    // DAY2 (Tuesday, isodow 2): 13:00 party 2.
    expect(byKey.get("2-13")?.covers).toBe(2);
    expect(cells.length).toBe(4);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const bounds = filter();
    const cells = await asUser(ctx.userAId, (tx) => getPeakTimesReport(tx, ctx.venueBId, bounds));
    expect(cells).toEqual([]);
  });
});

describe("reports — occupancy", () => {
  it("computes utilisation per service against seats × sessions", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) =>
      getOccupancyReport(tx, ctx.venueAId, bounds, { fromDate: DAY1_LOCAL, toDate: DAY2_LOCAL }),
    );
    // Venue A: one 10-top table, both services run every day → 2
    // sessions × 10 seats = 20 capacity each.
    // Lunch realised: 6 (day1) + 2 (day2) = 8 → 40%. Dinner: 6 → 30%.
    const byName = new Map(rows.map((r) => [r.serviceName, r]));
    const lunch = byName.get("Lunch");
    expect(lunch?.sessionsInRange).toBe(2);
    expect(lunch?.capacityPerSession).toBe(10);
    expect(lunch?.totalCapacity).toBe(20);
    expect(lunch?.coversRealised).toBe(8);
    expect(lunch?.utilisation).toBeCloseTo(0.4, 5);
    const dinner = byName.get("Dinner");
    expect(dinner?.coversRealised).toBe(6);
    expect(dinner?.utilisation).toBeCloseTo(0.3, 5);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) =>
      getOccupancyReport(tx, ctx.venueBId, bounds, { fromDate: DAY1_LOCAL, toDate: DAY2_LOCAL }),
    );
    expect(rows).toEqual([]);
  });
});

describe("reports — reviews", () => {
  it("aggregates count, average and source mix for venue A", async () => {
    const bounds = filter();
    const report = await asUser(ctx.userAId, (tx) => getReviewsReport(tx, ctx.venueAId, bounds));
    expect(report.count).toBe(2);
    expect(report.avgRating).toBeCloseTo(4, 5);
    const bySource = new Map(report.bySource.map((s) => [s.source, s]));
    expect(bySource.get("internal")?.count).toBe(1);
    expect(bySource.get("google")?.count).toBe(1);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const bounds = filter();
    const report = await asUser(ctx.userAId, (tx) => getReviewsReport(tx, ctx.venueBId, bounds));
    expect(report.count).toBe(0);
    expect(report.avgRating).toBeNull();
  });
});

describe("reports — spend", () => {
  it("totals POS orders and computes per-cover only over covered orders", async () => {
    const bounds = filter();
    const report = await asUser(ctx.userAId, (tx) => getSpendReport(tx, ctx.venueAId, bounds));
    expect(report.orders).toBe(2);
    expect(report.revenueMinor).toBe(8000);
    expect(report.avgPerOrderMinor).toBe(4000);
    // Only the £50 order reported covers (2) → £25/cover; the £30
    // cover-less order must not deflate the number.
    expect(report.covers).toBe(2);
    expect(report.avgPerCoverMinor).toBe(2500);
    expect(report.byDay.length).toBe(2);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const bounds = filter();
    const report = await asUser(ctx.userAId, (tx) => getSpendReport(tx, ctx.venueBId, bounds));
    expect(report.orders).toBe(0);
    expect(report.revenueMinor).toBe(0);
  });
});
