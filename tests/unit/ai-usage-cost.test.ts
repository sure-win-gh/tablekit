// Cost derivation for the ai_usage ledger (lib/billing/ai-usage.ts).
//
// Pins the price map to the published Haiku 4.5 rate card
// ($1/MTok in, $5/MTok out) at the fixed 80p/USD constant.

import { describe, expect, it } from "vitest";

import { estAiCostPence } from "@/lib/billing/ai-usage";

describe("estAiCostPence", () => {
  it("zero tokens cost zero", () => {
    expect(estAiCostPence({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("1M input tokens = $1 = 80p", () => {
    expect(estAiCostPence({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(80, 10);
  });

  it("1M output tokens = $5 = 400p", () => {
    expect(estAiCostPence({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(400, 10);
  });

  it("a typical enquiry (900 in / 150 out) is a fraction of a penny", () => {
    const pence = estAiCostPence({ inputTokens: 900, outputTokens: 150 });
    // 900/1M * 80 + 150/1M * 400 = 0.072 + 0.06 = 0.132p — the reason
    // cost is derived, not stored as an integer pence column.
    expect(pence).toBeCloseTo(0.132, 6);
    expect(pence).toBeLessThan(2); // spec: <£0.02 per enquiry
  });

  it("scales linearly", () => {
    const one = estAiCostPence({ inputTokens: 1000, outputTokens: 500 });
    const ten = estAiCostPence({ inputTokens: 10_000, outputTokens: 5_000 });
    expect(ten).toBeCloseTo(one * 10, 10);
  });
});
