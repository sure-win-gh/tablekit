// Phase 1 (booking-page) — loadPublicReviews aggregate + list coverage.
//
// Exercises the rich-page reviews loader against the real schema: the
// aggregate must combine consented-internal + google and EXCLUDE
// non-consented and erased-guest internal reviews; the list must decrypt
// (both sources are encrypted) and sort newest-first. See
// docs/specs/booking-page.md.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);

type Ctx = { userId: string; orgId: string; venueId: string };
let ctx: Ctx;

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  const { encryptPii } = await import("@/lib/security/crypto");

  const { data, error } = await admin.auth.admin.createUser({
    email: `bpr-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const userId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `BPR ${run}`, slug: `bpr-${run}` })
    .returning({ id: schema.organisations.id });
  await db.insert(schema.memberships).values({
    userId,
    organisationId: org!.id,
    role: "owner",
  });
  const orgId = org!.id;

  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: orgId, name: `V ${run}`, venueType: "restaurant" })
    .returning({ id: schema.venues.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: orgId, venueId: venue!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [service] = await db
    .insert(schema.services)
    .values({
      organisationId: orgId,
      venueId: venue!.id,
      name: "Dinner",
      schedule: { days: ["fri"], start: "17:00", end: "23:00" },
      turnMinutes: 90,
    })
    .returning({ id: schema.services.id });
  const venueId = venue!.id;

  // One guest + booking per internal review (bookingId is unique per review).
  const mkInternalGuestBooking = async (firstName: string, erased: boolean) => {
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName,
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `h_${firstName}_${run}`,
        ...(erased ? { erasedAt: at("2026-01-01T00:00:00Z") } : {}),
      })
      .returning({ id: schema.guests.id });
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: orgId,
        venueId,
        serviceId: service!.id,
        areaId: area!.id,
        guestId: g!.id,
        partySize: 2,
        startAt: at("2026-09-04T18:00:00Z"),
        endAt: at("2026-09-04T19:30:00Z"),
        status: "finished",
        source: "host",
      })
      .returning({ id: schema.bookings.id });
    return { guestId: g!.id, bookingId: b!.id };
  };

  const consented5 = await mkInternalGuestBooking("Ivy", false);
  const consented3 = await mkInternalGuestBooking("Jon", false);
  const nonConsented1 = await mkInternalGuestBooking("Kim", false);
  const erased5 = await mkInternalGuestBooking("Lee", true);

  const cipher = (text: string) => encryptPii(orgId, text);

  await db.insert(schema.reviews).values([
    // consented internal — both count + appear in list
    {
      organisationId: orgId,
      venueId,
      bookingId: consented5.bookingId,
      guestId: consented5.guestId,
      rating: 5,
      commentCipher: await cipher("Outstanding, will return"),
      showcaseConsentAt: at("2026-09-05T10:00:00Z"),
      submittedAt: at("2026-09-05T10:00:00Z"),
    },
    {
      organisationId: orgId,
      venueId,
      bookingId: consented3.bookingId,
      guestId: consented3.guestId,
      rating: 3,
      commentCipher: await cipher("Decent but slow service"),
      showcaseConsentAt: at("2026-09-06T10:00:00Z"),
      submittedAt: at("2026-09-06T10:00:00Z"),
    },
    // non-consented internal — excluded from aggregate + list
    {
      organisationId: orgId,
      venueId,
      bookingId: nonConsented1.bookingId,
      guestId: nonConsented1.guestId,
      rating: 1,
      commentCipher: await cipher("Hidden, no consent"),
      submittedAt: at("2026-09-07T10:00:00Z"),
    },
    // erased-guest consented internal — excluded
    {
      organisationId: orgId,
      venueId,
      bookingId: erased5.bookingId,
      guestId: erased5.guestId,
      rating: 5,
      commentCipher: await cipher("Erased guest, must not show"),
      showcaseConsentAt: at("2026-09-08T10:00:00Z"),
      submittedAt: at("2026-09-08T10:00:00Z"),
    },
    // google — all count; first two have comments, third is comment-less
    {
      organisationId: orgId,
      venueId,
      source: "google",
      externalId: `g1_${run}`,
      externalUrl: "https://maps.google.com/r/g1",
      reviewerDisplayName: "Alice",
      rating: 5,
      commentCipher: await cipher("Great spot near the station"),
      submittedAt: at("2026-09-09T10:00:00Z"),
    },
    {
      organisationId: orgId,
      venueId,
      source: "google",
      externalId: `g2_${run}`,
      externalUrl: "https://maps.google.com/r/g2",
      reviewerDisplayName: "Bob",
      rating: 4,
      commentCipher: await cipher("Nice food, friendly staff"),
      submittedAt: at("2026-09-10T10:00:00Z"),
    },
    {
      organisationId: orgId,
      venueId,
      source: "google",
      externalId: `g3_${run}`,
      reviewerDisplayName: "Cara",
      rating: 2,
      commentCipher: null, // comment-less: counts toward aggregate, not the list
      submittedAt: at("2026-09-11T10:00:00Z"),
    },
  ]);

  ctx = { userId, orgId, venueId };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("loadPublicReviews", () => {
  it("aggregates consented-internal + google and excludes non-consented/erased", async () => {
    const { loadPublicReviews } = await import("@/lib/public/venue");
    const r = await loadPublicReviews(ctx.venueId);
    // counted ratings: internal 5,3 + google 5,4,2 = 5 reviews, sum 19
    expect(r.count).toBe(5);
    expect(r.average).toBe(3.8);
    expect(r.bySource).toEqual({ internal: 2, google: 3 });
  });

  it("lists decrypted reviews (both sources), newest-first, comment-less excluded", async () => {
    const { loadPublicReviews } = await import("@/lib/public/venue");
    const r = await loadPublicReviews(ctx.venueId);
    // 2 internal + 2 google have comments; the comment-less google is omitted.
    expect(r.items).toHaveLength(4);
    // newest-first: google Bob (09-10) then Alice (09-09) then internal Jon (09-06) then Ivy (09-05)
    expect(r.items.map((i) => i.author)).toEqual(["Bob", "Alice", "Jon", "Ivy"]);
    const bob = r.items[0]!;
    expect(bob.source).toBe("google");
    expect(bob.comment).toBe("Nice food, friendly staff");
    expect(bob.externalUrl).toBe("https://maps.google.com/r/g2");
    const ivy = r.items[3]!;
    expect(ivy.source).toBe("internal");
    expect(ivy.comment).toBe("Outstanding, will return");
    expect(ivy.externalUrl).toBeNull();
    // never leak a non-consented/erased comment
    expect(r.items.some((i) => i.comment.includes("Hidden"))).toBe(false);
    expect(r.items.some((i) => i.comment.includes("Erased"))).toBe(false);
  });

  it("returns a zero aggregate for a venue with no reviews", async () => {
    const { loadPublicReviews } = await import("@/lib/public/venue");
    const empty = await loadPublicReviews("00000000-0000-0000-0000-000000000000");
    expect(empty).toEqual({
      average: 0,
      count: 0,
      bySource: { internal: 0, google: 0 },
      items: [],
    });
  });
});
