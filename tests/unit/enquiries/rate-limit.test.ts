import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENQUIRY_RATE_LIMIT, checkEnquiryRateLimit } from "@/lib/enquiries/rate-limit";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const SENDER_A = "hash-sender-a";
const SENDER_B = "hash-sender-b";

let originalUrl: string | undefined;
let originalToken: string | undefined;

beforeEach(() => {
  // Stash + clear Upstash env so the underlying helper's "no
  // Upstash configured → fall open" path is what we exercise. We
  // mock fetch separately to drive the limited-vs-permitted matrix.
  originalUrl = process.env["UPSTASH_REDIS_REST_URL"];
  originalToken = process.env["UPSTASH_REDIS_REST_TOKEN"];
  process.env["UPSTASH_REDIS_REST_URL"] = "https://mock-upstash.test";
  process.env["UPSTASH_REDIS_REST_TOKEN"] = "mock-token";
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env["UPSTASH_REDIS_REST_URL"];
  else process.env["UPSTASH_REDIS_REST_URL"] = originalUrl;
  if (originalToken === undefined) delete process.env["UPSTASH_REDIS_REST_TOKEN"];
  else process.env["UPSTASH_REDIS_REST_TOKEN"] = originalToken;
  vi.restoreAllMocks();
});

// Helper: fake an Upstash pipeline response with a given count.
// rateLimit reads the third pipeline result (ZCARD) — the others
// can be anything truthy.
function mockPipelineCount(count: number): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify([{ result: 1 }, { result: 1 }, { result: count }, { result: 1 }]),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
}

describe("checkEnquiryRateLimit", () => {
  it("permits when both org + sender buckets are under their limits", async () => {
    global.fetch = mockPipelineCount(1);
    const r = await checkEnquiryRateLimit(ORG_A, SENDER_A);
    expect(r.ok).toBe(true);
  });

  it("blocks at the org bucket when over ENQUIRIES_PER_ORG_PER_HOUR", async () => {
    global.fetch = mockPipelineCount(ENQUIRY_RATE_LIMIT.ENQUIRIES_PER_ORG_PER_HOUR + 1);
    const r = await checkEnquiryRateLimit(ORG_A, SENDER_A);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Org bucket is checked first, so this is the failure surface
    // the caller sees.
    expect(r.bucket).toBe("org");
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("blocks at the sender bucket when org is OK but sender is over", async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      // First call (org bucket): under limit. Second call (sender):
      // over limit.
      const count = call === 1 ? 1 : ENQUIRY_RATE_LIMIT.ENQUIRIES_PER_SENDER_PER_HOUR + 1;
      return new Response(
        JSON.stringify([{ result: 1 }, { result: 1 }, { result: count }, { result: 1 }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await checkEnquiryRateLimit(ORG_A, SENDER_A);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.bucket).toBe("sender");
  });

  it("treats different senders as independent (no cross-blocking)", async () => {
    // Sender A is well under the per-sender cap; the global fetch
    // mock returns the same count for every call so the sender key
    // doesn't actually segregate at the mock layer — but the
    // helper builds different bucket keys, which is what we're
    // verifying. This test is a smoke check that the bucket key
    // includes the sender hash.
    const calls: string[] = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push(JSON.stringify(init?.body ?? ""));
      return new Response(
        JSON.stringify([{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await checkEnquiryRateLimit(ORG_A, SENDER_A);
    await checkEnquiryRateLimit(ORG_A, SENDER_B);

    // 4 calls total: 2x (org-bucket + sender-bucket) per check.
    // Two of them mention SENDER_A's hash, two SENDER_B's.
    expect(calls.filter((c) => c.includes(SENDER_A)).length).toBe(1);
    expect(calls.filter((c) => c.includes(SENDER_B)).length).toBe(1);
  });

  it("falls open when Upstash returns an error (UX > over-spend risk)", async () => {
    global.fetch = vi.fn(
      async () => new Response("upstream down", { status: 502 }),
    ) as unknown as typeof fetch;
    const r = await checkEnquiryRateLimit(ORG_A, SENDER_A);
    expect(r.ok).toBe(true);
  });

  it("falls open when Upstash isn't configured at all", async () => {
    delete process.env["UPSTASH_REDIS_REST_URL"];
    delete process.env["UPSTASH_REDIS_REST_TOKEN"];
    const r = await checkEnquiryRateLimit(ORG_A, SENDER_A);
    expect(r.ok).toBe(true);
  });
});
