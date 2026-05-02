// Integration test for the enquiry runner.
//
// We don't call Bedrock — the LLM client is swapped via the test
// seam in `lib/llm/bedrock.ts`. The DB / availability engine /
// crypto / draft template all run for real.
//
// Cases covered:
//   - Happy path: received → draft_ready, encrypted parsed JSON +
//     draft round-trip, suggested_slots populated.
//   - Not-a-booking-request: received → discarded, no slots, generic
//     draft body still encrypted.
//   - Permanent parser failure: received → failed with a sanitised
//     error.
//   - Transient parser failure under the attempt budget: stays at
//     'received', parse_attempts bumped, error persisted but
//     non-terminal.
//   - Idempotency / concurrency: two concurrent processEnquiry calls
//     don't double-process. (One wins via FOR UPDATE SKIP LOCKED;
//     the other reports 'skipped'.)

import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { processEnquiry } from "@/lib/enquiries/runner";
import type { ParsedEnquiry } from "@/lib/enquiries/types";
import { __setClientForTest } from "@/lib/llm/bedrock";
import { type Ciphertext, decryptPii, encryptPii, type Plaintext } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = { orgId: string; venueId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Enq-Run ${run}`, slug: `enq-run-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");

  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org.id,
      name: "Enquiry Cafe",
      venueType: "cafe",
      slug: `enq-run-cafe-${run}`,
    })
    .returning({ id: schema.venues.id });
  if (!venue) throw new Error("venue insert returned no row");

  ctx = { orgId: org.id, venueId: venue.id };

  // Pre-warm the org's DEK before any parallel `Promise.all` of
  // encryptPii calls. There's a known race in `lib/security/
  // crypto.ts:getDek` — concurrent first-time encrypts each
  // generate their own DEK + race to UPDATE wrapped_dek, so
  // `Promise.all([encryptPii(...), encryptPii(...)])` on a fresh
  // org can produce ciphers that decrypt with different keys. A
  // single sequential call provisions the DEK once, then later
  // parallel calls all hit the cache.
  await encryptPii(ctx.orgId, "" as Plaintext);
});

afterAll(async () => {
  __setClientForTest(null);
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

// Build an enquiry row in the 'received' state with a fixture body.
async function seedEnquiry(bodyText: string): Promise<string> {
  const [from, subject, body] = await Promise.all([
    encryptPii(ctx.orgId, "guest@example.com" as Plaintext),
    encryptPii(ctx.orgId, "Booking enquiry" as Plaintext),
    encryptPii(ctx.orgId, bodyText as Plaintext),
  ]);
  const [row] = await db
    .insert(schema.enquiries)
    .values({
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      fromEmailHash: `h-${run}-${Math.random()}`,
      fromEmailCipher: from,
      subjectCipher: subject,
      bodyCipher: body,
    })
    .returning({ id: schema.enquiries.id });
  if (!row) throw new Error("enquiries insert returned no row");
  return row.id;
}

// Inject a mocked Bedrock client whose `messages.parse` returns a
// pre-canned ParsedEnquiry.
function mockParserOk(parsed: ParsedEnquiry) {
  const parseFn = vi.fn().mockResolvedValue({ parsed_output: parsed });
  __setClientForTest({ messages: { parse: parseFn } } as unknown as AnthropicBedrock);
  return parseFn;
}

function mockParserThrow(err: unknown) {
  const parseFn = vi.fn().mockRejectedValue(err);
  __setClientForTest({ messages: { parse: parseFn } } as unknown as AnthropicBedrock);
  return parseFn;
}

describe("processEnquiry — booking_request happy path", () => {
  it("transitions received → draft_ready with encrypted parsed + draft + slots", async () => {
    mockParserOk({
      kind: "booking_request",
      partySize: 4,
      requestedDate: "2026-06-15",
      requestedTimeWindow: "evening",
      specialRequests: [],
      guestFirstName: "Jane",
      guestLastName: "Doe",
    });
    const enquiryId = await seedEnquiry("Hi, table for 4 next month, evening please. Jane");

    const result = await processEnquiry(enquiryId);
    expect(result.status).toBe("draft_ready");

    const [row] = await db
      .select()
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, enquiryId));
    expect(row?.status).toBe("draft_ready");
    expect(row?.parseAttempts).toBe(1);
    expect(row?.parsedCipher).not.toBeNull();
    expect(row?.draftReplyCipher).not.toBeNull();

    // suggested_slots is plaintext jsonb — no slots seeded for this
    // venue so it should be an empty array, not null.
    expect(Array.isArray(row?.suggestedSlots)).toBe(true);

    // Parsed JSON round-trips.
    const parsed = JSON.parse(
      await decryptPii(ctx.orgId, row!.parsedCipher as Ciphertext),
    ) as ParsedEnquiry;
    expect(parsed.kind).toBe("booking_request");
    expect(parsed.guestFirstName).toBe("Jane");

    // Draft body decrypts to a non-empty string with the human
    // fallback line baked in (spec acceptance criterion).
    const draft = await decryptPii(ctx.orgId, row!.draftReplyCipher as Ciphertext);
    expect(draft).toContain("Hi Jane,");
    expect(draft).toContain("Reply to this email");
  });
});

describe("processEnquiry — not_a_booking_request", () => {
  it("transitions received → discarded with a generic draft", async () => {
    mockParserOk({
      kind: "not_a_booking_request",
      partySize: null,
      requestedDate: null,
      requestedTimeWindow: null,
      specialRequests: [],
      guestFirstName: null,
      guestLastName: null,
    });
    const enquiryId = await seedEnquiry("hello, just saying hi");

    const result = await processEnquiry(enquiryId);
    expect(result.status).toBe("discarded");

    const [row] = await db
      .select()
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, enquiryId));
    expect(row?.status).toBe("discarded");
    expect(row?.suggestedSlots).toEqual([]);

    const draft = await decryptPii(ctx.orgId, row!.draftReplyCipher as Ciphertext);
    expect(draft).toContain("Thanks for getting in touch");
    expect(draft).toContain("Reply to this email");
  });
});

describe("processEnquiry — failure paths", () => {
  it("classifies a permanent parser error as failed (sanitised)", async () => {
    // Inject a 4xx-class error via the Bedrock SDK's APIError
    // hierarchy. AnthropicBedrock shares the @anthropic-ai/sdk error
    // classes, so the wrapper's classifyError treats this as
    // permanent.
    const Anthropic = await import("@anthropic-ai/sdk");
    const err = Object.create(Anthropic.default.APIError.prototype);
    Object.assign(err, { status: 400, message: "bad request" });
    mockParserThrow(err);

    const enquiryId = await seedEnquiry("anything");
    const result = await processEnquiry(enquiryId);
    expect(result.status).toBe("failed");

    const [row] = await db
      .select({ status: schema.enquiries.status, error: schema.enquiries.error })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, enquiryId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBeTruthy();
    expect(row?.error?.length).toBeLessThanOrEqual(500);
  });

  it("retains a transient parser error at 'received' (under attempt budget)", async () => {
    const Anthropic = await import("@anthropic-ai/sdk");
    const err = Object.create(Anthropic.default.RateLimitError.prototype);
    Object.assign(err, { status: 429, message: "rate limited" });
    mockParserThrow(err);

    const enquiryId = await seedEnquiry("anything");
    const first = await processEnquiry(enquiryId);
    expect(first.status).toBe("skipped");
    if (first.status === "skipped") {
      // Distinguishes "we'll retry" from "all done" so PR4's UI
      // can show the right state.
      expect(first.reason).toBe("retry-pending");
    }

    const [row] = await db
      .select({
        status: schema.enquiries.status,
        parseAttempts: schema.enquiries.parseAttempts,
        error: schema.enquiries.error,
      })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, enquiryId));
    // Reset to 'received' so the cron retries; attempts bumped.
    expect(row?.status).toBe("received");
    expect(row?.parseAttempts).toBe(1);
    expect(row?.error).toContain("rate limited");
  });
});

describe("processEnquiry — concurrency", () => {
  it("two concurrent calls on the same received enquiry do not double-process", async () => {
    mockParserOk({
      kind: "booking_request",
      partySize: 2,
      requestedDate: "2026-06-15",
      requestedTimeWindow: "evening",
      specialRequests: [],
      guestFirstName: "Conc",
      guestLastName: null,
    });
    const enquiryId = await seedEnquiry("table for 2");

    const [a, b] = await Promise.all([processEnquiry(enquiryId), processEnquiry(enquiryId)]);
    const statuses = [a.status, b.status].sort();
    // One claim wins (draft_ready); the other sees the row as
    // already-locked or already-terminal (skipped).
    expect(statuses).toEqual(["draft_ready", "skipped"].sort());

    const [row] = await db
      .select({
        status: schema.enquiries.status,
        parseAttempts: schema.enquiries.parseAttempts,
      })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, enquiryId));
    expect(row?.status).toBe("draft_ready");
    // Parse attempts should be 1 — only one worker won the claim.
    expect(row?.parseAttempts).toBe(1);
  });
});
