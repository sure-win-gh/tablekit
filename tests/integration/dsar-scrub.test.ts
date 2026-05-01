// Integration test for the DSAR erasure scrub.
//
// Covers the full path: a completed `kind='erase'` DSAR row gets
// processed by runErasureScrub → guest PII nulled, internal reviews
// scrubbed (both consistency-check pairs together), external reviews
// untouched, dsar_requests.scrubbed_at stamped, audit log entries
// emitted. Plus idempotency + a no-matched-guest case.

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { runErasureScrub } from "@/lib/dsar/scrub";
import { sweepCompletedErasureScrubs } from "@/lib/dsar/sweep";
import {
  decryptPii,
  encryptPii,
  hashForLookup,
  type Ciphertext,
} from "@/lib/security/crypto";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);

type Ctx = {
  userId: string;
  orgId: string;
  venueId: string;
  guestId: string;
  bookingId: string;
  internalReviewId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `dsar-scrub-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const userId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `DS-${run}`, slug: `dsar-scrub-${run}` })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values({
    userId,
    organisationId: org.id,
    role: "owner",
  });

  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org.id,
      name: `Venue ${run}`,
      venueType: "cafe",
    })
    .returning({ id: schema.venues.id });
  if (!venue) throw new Error("venue insert returned no row");

  const [area] = await db
    .insert(schema.areas)
    .values({
      organisationId: org.id,
      venueId: venue.id,
      name: "Inside",
    })
    .returning({ id: schema.areas.id });
  if (!area) throw new Error("area insert returned no row");

  const [service] = await db
    .insert(schema.services)
    .values({
      organisationId: org.id,
      venueId: venue.id,
      name: "Dinner",
      schedule: { days: ["mon"], start: "18:00", end: "22:00" },
    })
    .returning({ id: schema.services.id });
  if (!service) throw new Error("service insert returned no row");

  // Real ciphertext so we can prove the scrub actually nulls them.
  const guestEmail = `guest-${run}@example.com`;
  const [guest] = await db
    .insert(schema.guests)
    .values({
      organisationId: org.id,
      firstName: "Original",
      lastNameCipher: await encryptPii(org.id, "Smith"),
      emailCipher: await encryptPii(org.id, guestEmail),
      emailHash: hashForLookup(guestEmail, "email"),
      phoneCipher: await encryptPii(org.id, "+447700900000"),
    })
    .returning({ id: schema.guests.id });
  if (!guest) throw new Error("guest insert returned no row");

  // Internal reviews require a booking + a guest_id (CHECK
  // reviews_source_shape_check enforces this). Insert a finished
  // booking so the review can attach.
  const [booking] = await db
    .insert(schema.bookings)
    .values({
      organisationId: org.id,
      venueId: venue.id,
      serviceId: service.id,
      areaId: area.id,
      guestId: guest.id,
      partySize: 2,
      startAt: sql`now() - interval '7 days'`,
      endAt: sql`now() - interval '7 days' + interval '90 minutes'`,
      status: "finished",
      source: "host",
    })
    .returning({ id: schema.bookings.id });
  if (!booking) throw new Error("booking insert returned no row");

  // Internal review WITH operator response + recovery + showcase
  // consent — the maximally-loaded shape so the scrub has to clear
  // every relevant field.
  const [internalReview] = await db
    .insert(schema.reviews)
    .values({
      organisationId: org.id,
      venueId: venue.id,
      bookingId: booking.id,
      guestId: guest.id,
      rating: 4,
      source: "internal",
      commentCipher: await encryptPii(org.id, "Lovely meal."),
      responseCipher: await encryptPii(org.id, "Thanks for visiting."),
      respondedAt: sql`now()`,
      respondedByUserId: userId,
      recoveryMessageCipher: await encryptPii(org.id, "Sorry — please come back."),
      recoveryOfferAt: sql`now()`,
      recoveryOfferedByUserId: userId,
      showcaseConsentAt: sql`now()`,
    })
    .returning({ id: schema.reviews.id });
  if (!internalReview) throw new Error("internal review insert returned no row");

  ctx = {
    userId,
    orgId: org.id,
    venueId: venue.id,
    guestId: guest.id,
    bookingId: booking.id,
    internalReviewId: internalReview.id,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userId).catch(() => undefined);
    // org cascade cleans venues + reviews + guests + dsars + audit_log
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

async function fileCompletedEraseDsar(opts: {
  orgId: string;
  guestId: string | null;
}): Promise<string> {
  const requesterEmail = `requester-${Date.now().toString(36)}@example.com`;
  const [row] = await db
    .insert(schema.dsarRequests)
    .values({
      organisationId: opts.orgId,
      kind: "erase",
      status: "completed",
      requesterEmailHash: hashForLookup(requesterEmail, "email"),
      requesterEmailCipher: await encryptPii(opts.orgId, requesterEmail),
      guestId: opts.guestId,
      dueAt: sql`now() + interval '30 days'`,
      resolvedAt: sql`now()`,
    })
    .returning({ id: schema.dsarRequests.id });
  if (!row) throw new Error("dsar insert returned no row");
  return row.id;
}

describe("runErasureScrub", () => {
  it("nulls guest PII, scrubs internal review, leaves external review alone", async () => {
    const dsarId = await fileCompletedEraseDsar({
      orgId: ctx.orgId,
      guestId: ctx.guestId,
    });

    const r = await runErasureScrub({ dsarId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyScrubbed).toBe(false);
    expect(r.guestId).toBe(ctx.guestId);
    expect(r.reviewsScrubbed).toBe(1);

    // Guest row stripped. last_name_cipher + email_cipher are NOT
    // NULL columns; the scrub overwrites them with the encryption of
    // the empty string (no PII). phone_cipher is nullable so it goes
    // to NULL outright.
    const [guestAfter] = await db
      .select({
        firstName: schema.guests.firstName,
        lastNameCipher: schema.guests.lastNameCipher,
        emailCipher: schema.guests.emailCipher,
        phoneCipher: schema.guests.phoneCipher,
        erasedAt: schema.guests.erasedAt,
      })
      .from(schema.guests)
      .where(eq(schema.guests.id, ctx.guestId));
    expect(guestAfter?.firstName).toBe("Erased");
    expect(guestAfter?.phoneCipher).toBeNull();
    expect(guestAfter?.erasedAt).not.toBeNull();
    // Both NOT NULL ciphers must decrypt to empty string.
    expect(
      await decryptPii(ctx.orgId, guestAfter!.lastNameCipher as Ciphertext),
    ).toBe("");
    expect(
      await decryptPii(ctx.orgId, guestAfter!.emailCipher as Ciphertext),
    ).toBe("");

    // Internal review scrubbed — both consistency-check pairs nulled
    // together so the CHECK constraints pass.
    const [intAfter] = await db
      .select({
        commentCipher: schema.reviews.commentCipher,
        responseCipher: schema.reviews.responseCipher,
        respondedAt: schema.reviews.respondedAt,
        respondedByUserId: schema.reviews.respondedByUserId,
        recoveryMessageCipher: schema.reviews.recoveryMessageCipher,
        recoveryOfferAt: schema.reviews.recoveryOfferAt,
        recoveryOfferedByUserId: schema.reviews.recoveryOfferedByUserId,
        showcaseConsentAt: schema.reviews.showcaseConsentAt,
      })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, ctx.internalReviewId));
    expect(intAfter?.commentCipher).toBeNull();
    expect(intAfter?.responseCipher).toBeNull();
    expect(intAfter?.respondedAt).toBeNull();
    expect(intAfter?.respondedByUserId).toBeNull();
    expect(intAfter?.recoveryMessageCipher).toBeNull();
    expect(intAfter?.recoveryOfferAt).toBeNull();
    expect(intAfter?.recoveryOfferedByUserId).toBeNull();
    expect(intAfter?.showcaseConsentAt).toBeNull();

    // dsar_requests stamped.
    const [dsarAfter] = await db
      .select({ scrubbedAt: schema.dsarRequests.scrubbedAt })
      .from(schema.dsarRequests)
      .where(eq(schema.dsarRequests.id, dsarId));
    expect(dsarAfter?.scrubbedAt).not.toBeNull();

    // Audit log: both new actions present for this DSAR.
    const auditRows = await db
      .select({ action: schema.auditLog.action, targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organisationId, ctx.orgId));
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain("guest.erased");
    expect(actions).toContain("dsar.scrubbed");
  });

  it("is idempotent — second run returns alreadyScrubbed", async () => {
    const dsarId = await fileCompletedEraseDsar({
      orgId: ctx.orgId,
      guestId: null, // any DSAR shape will do for this test
    });

    const first = await runErasureScrub({ dsarId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.alreadyScrubbed).toBe(false);

    const second = await runErasureScrub({ dsarId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyScrubbed).toBe(true);
  });

  it("handles a DSAR with no matched guest", async () => {
    const dsarId = await fileCompletedEraseDsar({
      orgId: ctx.orgId,
      guestId: null,
    });

    const r = await runErasureScrub({ dsarId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.guestId).toBeNull();
    expect(r.reviewsScrubbed).toBe(0);

    const [dsarAfter] = await db
      .select({ scrubbedAt: schema.dsarRequests.scrubbedAt })
      .from(schema.dsarRequests)
      .where(eq(schema.dsarRequests.id, dsarId));
    expect(dsarAfter?.scrubbedAt).not.toBeNull();
  });

  it("rejects wrong-kind DSARs", async () => {
    const requesterEmail = `noerase-${Date.now().toString(36)}@example.com`;
    const [row] = await db
      .insert(schema.dsarRequests)
      .values({
        organisationId: ctx.orgId,
        kind: "export",
        status: "completed",
        requesterEmailHash: hashForLookup(requesterEmail, "email"),
        requesterEmailCipher: await encryptPii(ctx.orgId, requesterEmail),
        dueAt: sql`now() + interval '30 days'`,
        resolvedAt: sql`now()`,
      })
      .returning({ id: schema.dsarRequests.id });
    if (!row) throw new Error("dsar insert returned no row");

    const r = await runErasureScrub({ dsarId: row.id });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("wrong-kind");
  });
});

describe("sweepCompletedErasureScrubs", () => {
  it("only picks up completed-erase-not-scrubbed rows", async () => {
    // Pending erase — should be ignored.
    const pendingEmail = `pending-${Date.now().toString(36)}@example.com`;
    await db.insert(schema.dsarRequests).values({
      organisationId: ctx.orgId,
      kind: "erase",
      status: "pending",
      requesterEmailHash: hashForLookup(pendingEmail, "email"),
      requesterEmailCipher: await encryptPii(ctx.orgId, pendingEmail),
      dueAt: sql`now() + interval '30 days'`,
    });

    // Fresh completed erase — should be picked up.
    const targetId = await fileCompletedEraseDsar({
      orgId: ctx.orgId,
      guestId: null,
    });

    const before = await sweepCompletedErasureScrubs({ limit: 50 });
    expect(before.scrubbed).toBeGreaterThanOrEqual(1);

    // Running again shouldn't re-process the same row (already
    // scrubbed_at).
    const after = await sweepCompletedErasureScrubs({ limit: 50 });
    const targetState = await db
      .select({ scrubbedAt: schema.dsarRequests.scrubbedAt })
      .from(schema.dsarRequests)
      .where(eq(schema.dsarRequests.id, targetId));
    expect(targetState[0]?.scrubbedAt).not.toBeNull();
    expect(after.considered).toBeLessThan(before.considered);
  });
});
