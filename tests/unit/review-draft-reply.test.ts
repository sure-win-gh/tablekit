// Unit test for the Phase 5b AI reply drafter.
//
// Mocks the AnthropicBedrock SDK so the test doesn't hit Bedrock.
// Three paths covered: happy structured response, parsed_output null
// (transient), and SDK throw (transient).

import { beforeEach, describe, expect, it } from "vitest";

import { __setDraftReplyClientForTest, draftReply } from "@/lib/reviews/draft-reply";

type ParsedShape = { parsed_output: { draft: string } | null };

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
  __setDraftReplyClientForTest(null);
});

const baseInput = {
  rating: 4,
  comment: "Lovely food, the bread was particularly good. Service was a bit slow at the start.",
  venueName: "Jane's Cafe",
};

describe("draftReply", () => {
  it("returns the model's draft on a structured response", async () => {
    const client = fakeClient({
      parsed_output: { draft: "Thank you for visiting — really glad you enjoyed the bread." },
    });
    __setDraftReplyClientForTest(client as never);

    const r = await draftReply(baseInput);
    expect(r).toEqual({
      ok: true,
      draft: "Thank you for visiting — really glad you enjoyed the bread.",
    });
  });

  it("returns transient when parsed_output is null (schema unsatisfiable)", async () => {
    const client = fakeClient({ parsed_output: null });
    __setDraftReplyClientForTest(client as never);

    const r = await draftReply(baseInput);
    expect(r).toEqual({ ok: false, reason: "transient" });
  });

  it("returns transient on SDK throw", async () => {
    const client = fakeClient(new Error("simulated 5xx"));
    __setDraftReplyClientForTest(client as never);

    const r = await draftReply(baseInput);
    expect(r).toEqual({ ok: false, reason: "transient" });
  });
});
