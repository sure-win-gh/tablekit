// Unit tests for the enquiry parser wrapper.
//
// We don't hit the real Bedrock endpoint — the SDK client is mocked.
// AnthropicBedrock shares the @anthropic-ai/sdk error hierarchy, so
// the `Anthropic.*` error classes still drive `instanceof` checks
// in the wrapper's `classifyError`.
//
// What we DO test:
//   1. The wrapper hands the raw body through to the SDK and returns
//      the parsed result on success.
//   2. The Zod schema rejects malformed shapes (drives one branch of
//      the wrapper's null-output path).
//   3. SDK errors are classified into transient vs permanent buckets.

import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi, afterEach } from "vitest";

import { __setClientForTest, parseEnquiry } from "@/lib/llm/bedrock";
import { ParsedEnquirySchema } from "@/lib/enquiries/types";

afterEach(() => {
  __setClientForTest(null);
  vi.restoreAllMocks();
});

function mockClient(parseFn: ReturnType<typeof vi.fn>): AnthropicBedrock {
  // The wrapper only ever calls `client.messages.parse(...)` — we
  // don't need a full SDK to satisfy that one method.
  return { messages: { parse: parseFn } } as unknown as AnthropicBedrock;
}

describe("ParsedEnquirySchema", () => {
  it("accepts a fully-populated booking request", () => {
    const r = ParsedEnquirySchema.safeParse({
      kind: "booking_request",
      partySize: 4,
      requestedDate: "2026-06-15",
      requestedTimeWindow: "evening",
      specialRequests: ["window seat", "anniversary"],
      guestFirstName: "Jane",
      guestLastName: "Doe",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a not-a-booking-request with all fields null", () => {
    const r = ParsedEnquirySchema.safeParse({
      kind: "not_a_booking_request",
      partySize: null,
      requestedDate: null,
      requestedTimeWindow: null,
      specialRequests: [],
      guestFirstName: null,
      guestLastName: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed requestedDate", () => {
    const r = ParsedEnquirySchema.safeParse({
      kind: "booking_request",
      partySize: 2,
      requestedDate: "next Friday",
      requestedTimeWindow: "evening",
      specialRequests: [],
      guestFirstName: null,
      guestLastName: null,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown time window", () => {
    const r = ParsedEnquirySchema.safeParse({
      kind: "booking_request",
      partySize: 2,
      requestedDate: "2026-06-15",
      requestedTimeWindow: "after_dark",
      specialRequests: [],
      guestFirstName: null,
      guestLastName: null,
    });
    expect(r.success).toBe(false);
  });

  it("caps specialRequests at 5 items", () => {
    const r = ParsedEnquirySchema.safeParse({
      kind: "booking_request",
      partySize: 2,
      requestedDate: "2026-06-15",
      requestedTimeWindow: "evening",
      specialRequests: ["a", "b", "c", "d", "e", "f"],
      guestFirstName: null,
      guestLastName: null,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a partySize of 0 or negative", () => {
    expect(
      ParsedEnquirySchema.safeParse({
        kind: "booking_request",
        partySize: 0,
        requestedDate: null,
        requestedTimeWindow: null,
        specialRequests: [],
        guestFirstName: null,
        guestLastName: null,
      }).success,
    ).toBe(false);
    expect(
      ParsedEnquirySchema.safeParse({
        kind: "booking_request",
        partySize: -1,
        requestedDate: null,
        requestedTimeWindow: null,
        specialRequests: [],
        guestFirstName: null,
        guestLastName: null,
      }).success,
    ).toBe(false);
  });
});

describe("parseEnquiry — happy path", () => {
  it("returns the parsed payload from the SDK", async () => {
    const parsedOutput = {
      kind: "booking_request" as const,
      partySize: 2,
      requestedDate: "2026-06-15",
      requestedTimeWindow: "evening" as const,
      specialRequests: ["birthday"],
      guestFirstName: "Jane",
      guestLastName: "Doe",
    };
    const parseFn = vi.fn().mockResolvedValue({ parsed_output: parsedOutput });
    __setClientForTest(mockClient(parseFn));

    const r = await parseEnquiry("Hi, table for two next month, evening, birthday. Jane");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed).toEqual(parsedOutput);

    // Sanity: the SDK was called with the right Bedrock model id +
    // structured-output config.
    expect(parseFn).toHaveBeenCalledTimes(1);
    const call = parseFn.mock.calls[0]![0];
    expect(call.model).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(call.output_config).toBeDefined();
    expect(call.output_config.format).toBeDefined();
  });
});

describe("parseEnquiry — null parsed_output", () => {
  it("treats a null parsed_output as transient", async () => {
    const parseFn = vi.fn().mockResolvedValue({ parsed_output: null });
    __setClientForTest(mockClient(parseFn));

    const r = await parseEnquiry("anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("transient");
  });
});

describe("parseEnquiry — error classification", () => {
  // The wrapper relies on `instanceof` + the `status` field, so a
  // hand-rolled prototype + status pair satisfies its checks without
  // pulling in the SDK's full APIError constructor signature.
  function makeApiError(status: number) {
    const err = Object.create(Anthropic.APIError.prototype);
    Object.assign(err, { status, message: `mock ${status}` });
    return err;
  }
  function makeRateLimitError() {
    const err = Object.create(Anthropic.RateLimitError.prototype);
    Object.assign(err, { status: 429, message: "mock 429" });
    return err;
  }

  it("classifies a RateLimitError as transient", async () => {
    const parseFn = vi.fn().mockRejectedValue(makeRateLimitError());
    __setClientForTest(mockClient(parseFn));

    const r = await parseEnquiry("anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("transient");
  });

  it("classifies a 5xx as transient", async () => {
    const parseFn = vi.fn().mockRejectedValue(makeApiError(503));
    __setClientForTest(mockClient(parseFn));

    const r = await parseEnquiry("anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("transient");
  });

  it("classifies a 4xx (non-429) as permanent", async () => {
    const parseFn = vi.fn().mockRejectedValue(makeApiError(400));
    __setClientForTest(mockClient(parseFn));

    const r = await parseEnquiry("anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("permanent");
  });

  it("classifies an unknown thrown value as transient", async () => {
    const parseFn = vi.fn().mockRejectedValue(new TypeError("network down"));
    __setClientForTest(mockClient(parseFn));

    const r = await parseEnquiry("anything");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("transient");
  });
});
