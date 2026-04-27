// Integration tests for the reviews phase schema.
//
// Covers:
//   1. Cross-tenant RLS — user A never sees org B's review rows.
//   2. No INSERT/UPDATE/DELETE policies for authenticated.
//   3. enforce_reviews_org_and_venue trigger — spoofed organisation_id /
//      venue_id are silently corrected to the parent booking's values.
//   4. CHECK constraint — rating outside 1..5 rejects.
//   5. UNIQUE on booking_id — second row for the same booking rejects.

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
  venueBId: string;
  bookingAId: string;
  bookingBId: string;
  guestAId: string;
  guestBId: string;
  reviewAId: string;
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

  const userAId = await mkUser(`rev-a-${run}@tablekit.test`);
  const userBId = await mkUser(`rev-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `R-A ${run}`, slug: `rev-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `R-B ${run}`, slug: `rev-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkBooking = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "cafe" })
      .returning({ id: schema.venues.id });
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId: v!.id, name: "Inside" })
      .returning({ id: schema.areas.id });
    const [s] = await db
      .insert(schema.services)
      .values({
        organisationId: orgId,
        venueId: v!.id,
        name: "Open",
        schedule: { days: ["mon"], start: "08:00", end: "17:00" },
        turnMinutes: 60,
      })
      .returning({ id: schema.services.id });
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "Test",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `rh_${orgId}_${run}`,
      })
      .returning({ id: schema.guests.id });
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: orgId,
        venueId: v!.id,
        serviceId: s!.id,
        areaId: a!.id,
        guestId: g!.id,
        partySize: 2,
        startAt: new Date("2026-09-01T12:00:00Z"),
        endAt: new Date("2026-09-01T13:00:00Z"),
        status: "finished",
        source: "host",
      })
      .returning({ id: schema.bookings.id });
    return { venueId: v!.id, bookingId: b!.id, guestId: g!.id };
  };

  const a = await mkBooking(orgA.id);
  const b = await mkBooking(orgB.id);

  const [revA] = await db
    .insert(schema.reviews)
    .values({
      organisationId: orgA.id,
      venueId: a.venueId,
      bookingId: a.bookingId,
      guestId: a.guestId,
      rating: 5,
    })
    .returning({ id: schema.reviews.id });
  await db.insert(schema.reviews).values({
    organisationId: orgB.id,
    venueId: b.venueId,
    bookingId: b.bookingId,
    guestId: b.guestId,
    rating: 4,
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId: a.venueId,
    venueBId: b.venueId,
    bookingAId: a.bookingId,
    bookingBId: b.bookingId,
    guestAId: a.guestId,
    guestBId: b.guestId,
    reviewAId: revA!.id,
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

describe("reviews — cross-tenant RLS", () => {
  it("user A sees only their own org's review rows", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.reviews));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.reviews).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          bookingId: ctx.bookingAId,
          guestId: ctx.guestAId,
          rating: 3,
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated UPDATE silently affects zero rows", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.reviews)
        .set({ rating: 1 })
        .where(eq(schema.reviews.id, ctx.reviewAId)),
    );
    const [row] = await db
      .select({ rating: schema.reviews.rating })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, ctx.reviewAId));
    expect(row?.rating).toBe(5);
  });
});

describe("enforce_reviews_org_and_venue trigger", () => {
  it("rewrites spoofed organisation_id + venue_id to match the parent booking", async () => {
    // Insert a brand new booking + review with spoofed org/venue, then
    // observe the trigger corrected them.
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: ctx.orgAId, name: "V2", venueType: "cafe" })
      .returning({ id: schema.venues.id });
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: ctx.orgAId, venueId: v!.id, name: "Inside" })
      .returning({ id: schema.areas.id });
    const [s] = await db
      .insert(schema.services)
      .values({
        organisationId: ctx.orgAId,
        venueId: v!.id,
        name: "Open",
        schedule: { days: ["mon"], start: "08:00", end: "17:00" },
        turnMinutes: 60,
      })
      .returning({ id: schema.services.id });
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: ctx.orgAId,
        venueId: v!.id,
        serviceId: s!.id,
        areaId: a!.id,
        guestId: ctx.guestAId,
        partySize: 2,
        startAt: new Date("2026-09-02T12:00:00Z"),
        endAt: new Date("2026-09-02T13:00:00Z"),
        status: "finished",
        source: "host",
      })
      .returning({ id: schema.bookings.id });

    const [row] = await db
      .insert(schema.reviews)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: ctx.venueBId, // spoof
        bookingId: b!.id,
        guestId: ctx.guestAId,
        rating: 5,
      })
      .returning({
        id: schema.reviews.id,
        organisationId: schema.reviews.organisationId,
        venueId: schema.reviews.venueId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    expect(row?.venueId).toBe(v!.id);
  });
});

describe("reviews — value constraints", () => {
  it("rejects rating outside 1..5", async () => {
    await expect(
      db.insert(schema.reviews).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        bookingId: ctx.bookingAId,
        guestId: ctx.guestAId,
        rating: 6,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.reviews).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        bookingId: ctx.bookingAId,
        guestId: ctx.guestAId,
        rating: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects a second review for the same booking_id", async () => {
    await expect(
      db.insert(schema.reviews).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        bookingId: ctx.bookingAId,
        guestId: ctx.guestAId,
        rating: 4,
      }),
    ).rejects.toThrow();
  });

  it("rejects an internal review without a booking_id", async () => {
    await expect(
      db.insert(schema.reviews).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        guestId: ctx.guestAId,
        rating: 4,
        source: "internal",
      }),
    ).rejects.toThrow();
  });

  it("rejects an external review missing reviewer_display_name", async () => {
    await expect(
      db.insert(schema.reviews).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        rating: 4,
        source: "google",
        externalId: `gbp_${run}_a`,
      }),
    ).rejects.toThrow();
  });

  it("accepts an external review with the expected shape", async () => {
    const [row] = await db
      .insert(schema.reviews)
      .values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        rating: 5,
        source: "google",
        externalId: `gbp_${run}_b`,
        reviewerDisplayName: "Public Reviewer",
      })
      .returning({ id: schema.reviews.id, organisationId: schema.reviews.organisationId });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.reviews).where(eq(schema.reviews.id, row!.id));
  });

  it("dedupes external reviews by (venue_id, source, external_id)", async () => {
    const externalId = `gbp_${run}_c`;
    await db.insert(schema.reviews).values({
      organisationId: ctx.orgAId,
      venueId: ctx.venueAId,
      rating: 4,
      source: "google",
      externalId,
      reviewerDisplayName: "First",
    });
    await expect(
      db.insert(schema.reviews).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        rating: 5,
        source: "google",
        externalId,
        reviewerDisplayName: "Duplicate",
      }),
    ).rejects.toThrow();
  });
});
