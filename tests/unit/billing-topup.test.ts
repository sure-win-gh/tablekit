// Unit coverage for the top-up amount guard — the server action rejects
// anything not in the preset set, so the client can't post an arbitrary
// charge amount.

import { describe, expect, it } from "vitest";

import { TOPUP_AMOUNTS_PENCE, isTopupAmount } from "@/lib/billing/topup";

describe("isTopupAmount", () => {
  it("accepts only the preset amounts", () => {
    for (const amt of TOPUP_AMOUNTS_PENCE) expect(isTopupAmount(amt)).toBe(true);
  });

  it("rejects arbitrary or off-list amounts", () => {
    expect(isTopupAmount(1)).toBe(false);
    expect(isTopupAmount(1500)).toBe(false);
    expect(isTopupAmount(0)).toBe(false);
    expect(isTopupAmount(-2000)).toBe(false);
    expect(isTopupAmount(999999)).toBe(false);
  });
});
