// Integration test for the operator inbox read path.
//
// Exercises `loadInboxList` and `loadEnquiryForOperator` against a
// real DB. Covers:
//   - bucket filter (needs_action / replied / discarded)
//   - subject + preview decrypt round-trip
//   - detail-load decrypt of body, parsed JSON, draft reply
//   - RLS: an admin-DB read can fetch any org's row, but the helpers
//     run via the user-RLS connection pattern in the page handlers,
//     so this test asserts that loadEnquiryForOperator filters by
//     venueId (defence-in-depth against a venueId-mismatch on a row
//     in the same caller's org).
//
// Auth and Plus-tier gating live in the action/page wrappers and are
// covered there.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { loadEnquiryForOperator, loadInboxList } from "@/lib/enquiries/inbox";
import type { ParsedEnquiry } from "@/lib/enquiries/types";
import { encryptPii, type Plaintext } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = { orgId: string; venueId: string; otherVenueId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Enq-Inbox ${run}`, slug: `enq-inbox-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");

  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org.id,
      name: "Inbox Cafe",
      venueType: "cafe",
      slug: `enq-inbox-${run}`,
    })
    .returning({ id: schema.venues.id });
  if (!venue) throw new Error("venue insert returned no row");

  const [other] = await db
    .insert(schema.venues)
    .values({
      organisationId: org.id,
      name: "Other Venue",
      venueType: "cafe",
      slug: `enq-inbox-other-${run}`,
    })
    .returning({ id: schema.venues.id });
  if (!other) throw new Error("other venue insert returned no row");

  ctx = { orgId: org.id, venueId: venue.id, otherVenueId: other.id };

  // Pre-warm DEK so the parallel encryptPii calls below all hit cache.
  await encryptPii(ctx.orgId, "" as Plaintext);
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

async function seed(opts: {
  status: "received" | "draft_ready" | "replied" | "discarded" | "failed" | "parsing";
  venueId?: string;
  parsed?: ParsedEnquiry | null;
  draft?: string | null;
  subject?: string;
  body?: string;
}): Promise<string> {
  const venueId = opts.venueId ?? ctx.venueId;
  const subject = opts.subject ?? "Booking";
  const body = opts.body ?? "Please book me in.";
  const [from, subj, bod] = await Promise.all([
    encryptPii(ctx.orgId, "guest@example.com" as Plaintext),
    encryptPii(ctx.orgId, subject as Plaintext),
    encryptPii(ctx.orgId, body as Plaintext),
  ]);
  const parsedCipher = opts.parsed
    ? await encryptPii(ctx.orgId, JSON.stringify(opts.parsed) as Plaintext)
    : null;
  const draftCipher = opts.draft ? await encryptPii(ctx.orgId, opts.draft as Plaintext) : null;
  const [row] = await db
    .insert(schema.enquiries)
    .values({
      organisationId: ctx.orgId,
      venueId,
      fromEmailHash: `h-${run}-${Math.random()}`,
      fromEmailCipher: from,
      subjectCipher: subj,
      bodyCipher: bod,
      parsedCipher,
      draftReplyCipher: draftCipher,
      status: opts.status,
    })
    .returning({ id: schema.enquiries.id });
  if (!row) throw new Error("seed insert returned no row");
  return row.id;
}

describe("loadInboxList — bucket filter", () => {
  it("groups received / parsing / draft_ready / failed under needs_action", async () => {
    const ids = await Promise.all([
      seed({ status: "received" }),
      seed({ status: "parsing" }),
      seed({ status: "draft_ready", draft: "Hi Jane,\n\nWe have a 7pm slot." }),
      seed({ status: "failed" }),
    ]);
    const list = await loadInboxList(db, {
      venueId: ctx.venueId,
      bucket: "needs_action",
    });
    const seenIds = new Set(list.map((r) => r.id));
    for (const id of ids) expect(seenIds.has(id)).toBe(true);
  });

  it("isolates the replied bucket", async () => {
    const repliedId = await seed({ status: "replied", draft: "sent" });
    const repliedList = await loadInboxList(db, {
      venueId: ctx.venueId,
      bucket: "replied",
    });
    expect(repliedList.some((r) => r.id === repliedId)).toBe(true);

    const needsActionList = await loadInboxList(db, {
      venueId: ctx.venueId,
      bucket: "needs_action",
    });
    expect(needsActionList.some((r) => r.id === repliedId)).toBe(false);
  });

  it("isolates the discarded bucket", async () => {
    const discardedId = await seed({ status: "discarded" });
    const list = await loadInboxList(db, {
      venueId: ctx.venueId,
      bucket: "discarded",
    });
    expect(list.some((r) => r.id === discardedId)).toBe(true);
  });

  it("scopes to the venueId — does not return other venues' enquiries", async () => {
    const otherId = await seed({ status: "draft_ready", venueId: ctx.otherVenueId });
    const list = await loadInboxList(db, {
      venueId: ctx.venueId,
      bucket: "needs_action",
    });
    expect(list.some((r) => r.id === otherId)).toBe(false);
  });
});

describe("loadInboxList — subject + preview decrypt", () => {
  it("returns the decrypted subject + preview built from parsed JSON", async () => {
    const id = await seed({
      status: "draft_ready",
      subject: "Table for 4 next Friday",
      parsed: {
        kind: "booking_request",
        partySize: 4,
        requestedDate: "2026-06-12",
        requestedTimeWindow: "evening",
        specialRequests: [],
        guestFirstName: "Jane",
        guestLastName: null,
      },
      draft: "Hi Jane",
    });
    const list = await loadInboxList(db, {
      venueId: ctx.venueId,
      bucket: "needs_action",
    });
    const row = list.find((r) => r.id === id);
    expect(row).toBeTruthy();
    expect(row?.subject).toBe("Table for 4 next Friday");
    expect(row?.preview).toContain("4 guests");
    expect(row?.preview).toContain("2026-06-12");
    expect(row?.hasDraft).toBe(true);
  });

  it("falls back to '(awaiting parse)' when parsedCipher is null", async () => {
    const id = await seed({ status: "received", subject: "Just arrived" });
    const list = await loadInboxList(db, {
      venueId: ctx.venueId,
      bucket: "needs_action",
    });
    const row = list.find((r) => r.id === id);
    expect(row?.preview).toBe("(awaiting parse)");
  });
});

describe("loadEnquiryForOperator", () => {
  it("decrypts subject, body, parsed JSON, and draft reply", async () => {
    const id = await seed({
      status: "draft_ready",
      subject: "Booking enquiry",
      body: "Hi, can we have a table for 2 at 8pm on Friday?",
      parsed: {
        kind: "booking_request",
        partySize: 2,
        requestedDate: "2026-06-12",
        requestedTimeWindow: "evening",
        specialRequests: ["window seat"],
        guestFirstName: "Sam",
        guestLastName: "Jones",
      },
      draft: "Hi Sam,\n\nWe have a table at 8pm.",
    });
    const detail = await loadEnquiryForOperator(db, { enquiryId: id, venueId: ctx.venueId });
    expect(detail).toBeTruthy();
    expect(detail?.subject).toBe("Booking enquiry");
    expect(detail?.body).toContain("table for 2 at 8pm");
    expect(detail?.parsed?.partySize).toBe(2);
    expect(detail?.parsed?.specialRequests).toEqual(["window seat"]);
    expect(detail?.draftReply).toContain("Hi Sam,");
    expect(detail?.fromEmail).toBe("guest@example.com");
  });

  it("returns null when the enquiry's venueId mismatches (defence-in-depth)", async () => {
    const id = await seed({ status: "draft_ready", venueId: ctx.otherVenueId });
    const detail = await loadEnquiryForOperator(db, {
      enquiryId: id,
      venueId: ctx.venueId, // wrong venue
    });
    expect(detail).toBeNull();
  });

  it("returns null when the enquiryId doesn't exist", async () => {
    const detail = await loadEnquiryForOperator(db, {
      enquiryId: "00000000-0000-0000-0000-000000000000",
      venueId: ctx.venueId,
    });
    expect(detail).toBeNull();
  });
});
