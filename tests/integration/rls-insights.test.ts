// Integration tests for the Booking Insights module.
//
// Mirrors rls-reports.test.ts in shape — two tenants, deterministic
// fixtures, RLS isolation assertion. The extras here are:
//
//   1. Explicit `createdAt` on every booking, since lead-time depends
//      on the gap between created_at and start_at.
//   2. A "midnight" booking on venue A — start_at at 23:30 local time,
//      created_at at 00:30 the same local day — to prove the bucket
//      uses venue-local dates (the UTC subtraction would put these on
//      different calendar days and miscount as "1d" instead of
//      "same-day").

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BookingStatus } from "@/lib/bookings/state";
import * as schema from "@/lib/db/schema";
import { parseFilter } from "@/lib/reports/filter";
import { getLeadTimeReport } from "@/lib/reports/insights/lead-time";

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
const DAY_LOCAL = "2026-05-11"; // BST — UTC+1

// Helpers for explicit UTC instants given a local wall-clock hh:mm in BST.
const atBst = (ymd: string, hh: number, mm = 0) =>
  new Date(`${ymd}T${String(hh - 1).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);

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
      user_metadata: { full_name: email },
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    return data.user.id;
  };

  const userAId = await mkUser(`ins-a-${run}@tablekit.test`);
  const userBId = await mkUser(`ins-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `I-A ${run}`, slug: `ins-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `I-B ${run}`, slug: `ins-b-${run}` })
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
    end: "23:59",
  };
  const mkService = async (orgId: string, venueId: string, name: string) => {
    const [s] = await db
      .insert(schema.services)
      .values({ organisationId: orgId, venueId, name, schedule, turnMinutes: 60 })
      .returning({ id: schema.services.id });
    return s!.id;
  };
  const serviceAId = await mkService(orgA.id, venueAId, "Main");
  const serviceBId = await mkService(orgB.id, venueBId, "Main");

  const mkGuest = async (orgId: string, suffix: string) => {
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "G",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `ihash_${orgId}_${suffix}_${run}`,
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };
  const guestAId = await mkGuest(orgA.id, "a");
  const guestBId = await mkGuest(orgB.id, "b");

  type SeedBooking = {
    orgId: string;
    venueId: string;
    serviceId: string;
    areaId: string;
    guestId: string;
    partySize: number;
    startAt: Date;
    endAt: Date;
    createdAt: Date;
    status: BookingStatus;
    source: string;
  };
  const mkBooking = (b: SeedBooking) =>
    db.insert(schema.bookings).values({
      organisationId: b.orgId,
      venueId: b.venueId,
      serviceId: b.serviceId,
      areaId: b.areaId,
      guestId: b.guestId,
      partySize: b.partySize,
      startAt: b.startAt,
      endAt: b.endAt,
      createdAt: b.createdAt,
      status: b.status,
      source: b.source,
    });

  // Venue A bookings — all start on DAY_LOCAL, varied created_at to exercise
  // buckets:
  //   • same-day (created 09:00, starts 19:00 local)
  //   • same-day midnight-edge (created 00:30 local, starts 23:30 local — the
  //     spec's smoking-gun for venue-tz date subtraction)
  //   • 1d (created day-before 19:00 local)
  //   • 2-3d (created 3 days before)
  //   • cancelled (5d before — must NOT count)
  //   • venue B booking on same day to verify RLS.
  const baseStart = atBst(DAY_LOCAL, 19); // 19:00 BST → 18:00 UTC
  const baseEnd = atBst(DAY_LOCAL, 20);

  await mkBooking({
    orgId: orgA.id,
    venueId: venueAId,
    serviceId: serviceAId,
    areaId: areaAId,
    guestId: guestAId,
    partySize: 2,
    startAt: baseStart,
    endAt: baseEnd,
    createdAt: atBst(DAY_LOCAL, 9), // same calendar day, ~10h earlier
    status: "confirmed",
    source: "widget",
  });
  await mkBooking({
    orgId: orgA.id,
    venueId: venueAId,
    serviceId: serviceAId,
    areaId: areaAId,
    guestId: guestAId,
    partySize: 4,
    startAt: atBst(DAY_LOCAL, 23, 30), // 23:30 BST → 22:30 UTC (same UTC date)
    endAt: atBst(DAY_LOCAL, 24, 30), // 00:30 next-day UTC
    createdAt: atBst(DAY_LOCAL, 0, 30), // 00:30 BST → 2026-05-10 23:30 UTC
    status: "confirmed",
    source: "widget",
  });
  await mkBooking({
    orgId: orgA.id,
    venueId: venueAId,
    serviceId: serviceAId,
    areaId: areaAId,
    guestId: guestAId,
    partySize: 3,
    startAt: baseStart,
    endAt: baseEnd,
    createdAt: atBst("2026-05-10", 19),
    status: "confirmed",
    source: "host",
  });
  await mkBooking({
    orgId: orgA.id,
    venueId: venueAId,
    serviceId: serviceAId,
    areaId: areaAId,
    guestId: guestAId,
    partySize: 2,
    startAt: baseStart,
    endAt: baseEnd,
    createdAt: atBst("2026-05-08", 12),
    status: "finished",
    source: "host",
  });
  await mkBooking({
    orgId: orgA.id,
    venueId: venueAId,
    serviceId: serviceAId,
    areaId: areaAId,
    guestId: guestAId,
    partySize: 2,
    startAt: baseStart,
    endAt: baseEnd,
    createdAt: atBst("2026-05-06", 12),
    status: "cancelled",
    source: "widget",
  });

  await mkBooking({
    orgId: orgB.id,
    venueId: venueBId,
    serviceId: serviceBId,
    areaId: areaBId,
    guestId: guestBId,
    partySize: 5,
    startAt: baseStart,
    endAt: baseEnd,
    createdAt: atBst("2026-05-09", 12),
    status: "confirmed",
    source: "widget",
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
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
    fromDate: DAY_LOCAL,
    toDate: DAY_LOCAL,
    timezone: TZ,
  });
  if (!r.ok) throw new Error("filter parse failed");
  return r.bounds;
};

describe("insights — lead time", () => {
  it("buckets bookings by venue-local lead-time days and excludes cancelled", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) => getLeadTimeReport(tx, ctx.venueAId, bounds));

    // Zero-fill: always 7 rows back, ordered by bucket sequence.
    expect(rows.map((r) => r.bucket)).toEqual([
      "same-day",
      "1d",
      "2-3d",
      "4-7d",
      "8-14d",
      "15-30d",
      "30d+",
    ]);

    const byBucket = new Map(rows.map((r) => [r.bucket, r]));
    // Same-day: the 09:00→19:00 booking + the 00:30→23:30 midnight-edge one.
    // The midnight-edge case is the smoking gun — if the SQL used UTC dates
    // it'd land in "1d" (created_at UTC date = 2026-05-10, start_at UTC
    // date = 2026-05-11), but in BST both project to 2026-05-11.
    expect(byBucket.get("same-day")?.bookings).toBe(2);
    expect(byBucket.get("1d")?.bookings).toBe(1);
    expect(byBucket.get("2-3d")?.bookings).toBe(1);
    // 5-day-out booking is cancelled → must not appear.
    expect(byBucket.get("4-7d")?.bookings).toBe(0);
  });

  it("user A querying venue B sees nothing — RLS isolation", async () => {
    const bounds = filter();
    const rows = await asUser(ctx.userAId, (tx) => getLeadTimeReport(tx, ctx.venueBId, bounds));
    // Zero-filled rows always returned; every bucket must be empty.
    expect(rows.every((r) => r.bookings === 0 && r.covers === 0)).toBe(true);
  });
});
