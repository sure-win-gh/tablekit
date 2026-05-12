// Unit test for the Phase 5 sentiment classifier.
//
// We mock the AnthropicBedrock SDK so the test asserts the classifier's
// behaviour without a Bedrock round-trip. Two paths to cover:
//   • Short comments skip the LLM entirely.
//   • Bedrock failures surface as transient (caller continues).
// The structured-output happy path is also covered.

import { beforeEach, describe, expect, it } from "vitest";

import { __setSentimentClientForTest, classifySentiment } from "@/lib/reviews/sentiment";

type ParsedShape = { parsed_output: { sentiment: "positive" | "neutral" | "negative" } | null };

function fakeClient(parsed: ParsedShape | Error): {
  messages: { parse: () => Promise<ParsedShape> };
} {
  return {
    messages: {
      parse: async () => {
        if (parsed instanceof Error) throw parsed;
        return parsed;
      },
    },
  };
}

beforeEach(() => {
  __setSentimentClientForTest(null);
});

describe("classifySentiment", () => {
  it("skips short comments without a Bedrock call", async () => {
    // No client injection — if we accidentally hit the client this
    // throws because no AWS creds are configured in unit tests.
    const r = await classifySentiment("good");
    expect(r).toEqual({ ok: false, reason: "skipped" });
  });

  it("returns the parsed label on success", async () => {
    const client = fakeClient({ parsed_output: { sentiment: "negative" } });
    // The injected client must satisfy the SDK's runtime contract for
    // .messages.parse — only the shape we use, not the full surface.
    __setSentimentClientForTest(client as never);

    const r = await classifySentiment("The starter was cold and the service was rude.");
    expect(r).toEqual({ ok: true, sentiment: "negative" });
  });

  it("returns transient on parsed_output null (model couldn't satisfy the schema)", async () => {
    const client = fakeClient({ parsed_output: null });
    __setSentimentClientForTest(client as never);

    const r = await classifySentiment(
      "Excellent meal, will be back. Staff were friendly and attentive.",
    );
    expect(r).toEqual({ ok: false, reason: "transient" });
  });

  it("returns transient on SDK throw", async () => {
    const client = fakeClient(new Error("simulated 5xx"));
    __setSentimentClientForTest(client as never);

    const r = await classifySentiment("Great evening, food was wonderful and service top notch.");
    expect(r).toEqual({ ok: false, reason: "transient" });
  });
});
