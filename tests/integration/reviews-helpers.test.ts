// Phase 7.5 — helper-level coverage for the review pipeline.
//
// These exercise the actual side-effecting helpers (escalation alert,
// public showcase loader) against the real schema, where the RLS
// integration test (rls-reviews.test.ts) only covers the data layer.
//
// Resend is gated behind MESSAGING_DISABLED=true so sendEmail short-
// circuits without hitting the network. The escalation helper still
// runs all the DB work (claim + audit + decrypt) and the rollback
// path on send failure.

import { sql, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);

// Force sendEmail to throw EmailSendError("messaging-disabled") so
// the escalation helper exercises rollback without a real Resend
// roundtrip. Set BEFORE any module imports the email client.
const originalDisabled = process.env["MESSAGING_DISABLED"];
process.env["MESSAGING_DISABLED"] = "true";

type Ctx = {
  userOwnerId: string;
  orgId: string;
  venueAId: string;
  venueBId: string;
  guestAId: string;
  bookingAId: string;
  bookingBId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `helper-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
    user_metadata: { full_name: "Helper Owner" },
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const userOwnerId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `H ${run}`, slug: `helper-${run}` })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values({
    userId: userOwnerId,
    organisationId: org.id,
    role: "owner",
  });

  const mkVenueAndBooking = async (slug: string, settings: Record<string, unknown> = {}) => {
    const [v] = await db
      .insert(schema.venues)
      .values({
        organisationId: org.id,
        name: `V-${slug}`,
        venueType: "cafe",
        settings,
      })
      .returning({ id: schema.venues.id });
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: org.id, venueId: v!.id, name: "Inside" })
      .returning({ id: schema.areas.id });
    const [s] = await db
      .insert(schema.services)
      .values({
        organisationId: org.id,
        venueId: v!.id,
        name: "Open",
        schedule: { days: ["mon"], start: "08:00", end: "17:00" },
        turnMinutes: 60,
      })
      .returning({ id: schema.services.id });
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: org.id,
        firstName: "Helga",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `hh_${slug}_${run}`,
      })
      .returning({ id: schema.guests.id });
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: org.id,
        venueId: v!.id,
        serviceId: s!.id,
        areaId: a!.id,
        guestId: g!.id,
        partySize: 2,
        startAt: new Date("2026-09-04T12:00:00Z"),
        endAt: new Date("2026-09-04T13:00:00Z"),
        status: "finished",
        source: "host",
      })
      .returning({ id: schema.bookings.id });
    return { venueId: v!.id, guestId: g!.id, bookingId: b!.id };
  };

  // Venue A: showcase enabled, escalation default-on. Venue B: both
  // disabled — proves the negative paths.
  const a = await mkVenueAndBooking("a", { showcaseEnabled: true });
  const b = await mkVenueAndBooking("b", {
    showcaseEnabled: false,
    escalationEnabled: false,
  });

  ctx = {
    userOwnerId,
    orgId: org.id,
    venueAId: a.venueId,
    venueBId: b.venueId,
    guestAId: a.guestId,
    bookingAId: a.bookingId,
    bookingBId: b.bookingId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userOwnerId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
  if (originalDisabled === undefined) delete process.env["MESSAGING_DISABLED"];
  else process.env["MESSAGING_DISABLED"] = originalDisabled;
});

beforeEach(async () => {
  // Reset reviews between tests so each test has a clean slate.
  await db
    .delete(schema.reviews)
    .where(
      sql`${schema.reviews.bookingId} in (${ctx.bookingAId}, ${ctx.bookingBId})`,
    );
});

describe("sendEscalationAlertIfNeeded", () => {
  it("rolls back escalation_alert_at when sendEmail throws", async () => {
    const { sendEscalationAlertIfNeeded } = await import("@/lib/reviews/escalation");
    const [r] = await db
      .insert(schema.reviews)
      .values({
        organisationId: ctx.orgId,
        venueId: ctx.venueAId,
        bookingId: ctx.bookingAId,
        guestId: ctx.guestAId,
        rating: 1,
      })
      .returning({ id: schema.reviews.id });
    // MESSAGING_DISABLED=true → sendEmail throws inside the post-claim
    // try/catch → escalation_alert_at must be cleared so a retry can
    // re-claim.
    await sendEscalationAlertIfNeeded(r!.id);
    const [after] = await db
      .select({ escalationAlertAt: schema.reviews.escalationAlertAt })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, r!.id));
    expect(after?.escalationAlertAt).toBeNull();
  });

  it("no-ops when escalationEnabled=false", async () => {
    const { sendEscalationAlertIfNeeded } = await import("@/lib/reviews/escalation");
    const [b] = await db
      .insert(schema.reviews)
      .values({
        organisationId: ctx.orgId,
        venueId: ctx.venueBId,
        bookingId: ctx.bookingBId,
        guestId: ctx.guestAId,
        rating: 1,
      })
      .returning({ id: schema.reviews.id });
    await sendEscalationAlertIfNeeded(b!.id);
    const [after] = await db
      .select({ escalationAlertAt: schema.reviews.escalationAlertAt })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, b!.id));
    expect(after?.escalationAlertAt).toBeNull();
  });

  it("no-ops when rating is above threshold", async () => {
    const { sendEscalationAlertIfNeeded } = await import("@/lib/reviews/escalation");
    const [r] = await db
      .insert(schema.reviews)
      .values({
        organisationId: ctx.orgId,
        venueId: ctx.venueAId,
        bookingId: ctx.bookingAId,
        guestId: ctx.guestAId,
        rating: 5,
      })
      .returning({ id: schema.reviews.id });
    await sendEscalationAlertIfNeeded(r!.id);
    const [after] = await db
      .select({ escalationAlertAt: schema.reviews.escalationAlertAt })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, r!.id));
    expect(after?.escalationAlertAt).toBeNull();
  });
});

describe("loadPublicShowcase", () => {
  it("returns [] when showcaseEnabled=false even with consented rows", async () => {
    const { loadPublicShowcase } = await import("@/lib/public/venue");
    await db.insert(schema.reviews).values({
      organisationId: ctx.orgId,
      venueId: ctx.venueBId,
      bookingId: ctx.bookingBId,
      guestId: ctx.guestAId,
      rating: 5,
      commentCipher: "v1:x:x:x",
      showcaseConsentAt: sql`now()`,
    });
    const result = await loadPublicShowcase(ctx.venueBId);
    expect(result).toEqual([]);
  });

  it("does not surface venue A's consented review under venue B", async () => {
    const { loadPublicShowcase } = await import("@/lib/public/venue");
    await db.insert(schema.reviews).values({
      organisationId: ctx.orgId,
      venueId: ctx.venueAId,
      bookingId: ctx.bookingAId,
      guestId: ctx.guestAId,
      rating: 5,
      commentCipher: "v1:x:x:x",
      showcaseConsentAt: sql`now()`,
    });
    // Venue B has showcase off AND no rows — the loader must not
    // return venue A's row even though they're in the same org.
    const result = await loadPublicShowcase(ctx.venueBId);
    expect(result).toEqual([]);
  });
});
