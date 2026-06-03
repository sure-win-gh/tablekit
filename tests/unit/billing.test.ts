// Unit coverage for the billing/usage + retention boundary math.

import { describe, expect, it } from "vitest";

import { CAMPAIGN_SEND_RETENTION_MONTHS, retentionCutoff } from "@/lib/campaigns/retention";
import { CHANNEL_COST_PENCE, billingPeriod, estimateCostPence } from "@/lib/billing/usage";

describe("billingPeriod", () => {
  it("formats the UTC yyyy-mm period", () => {
    expect(billingPeriod(new Date("2026-06-02T23:30:00Z"))).toBe("2026-06");
    expect(billingPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("estimateCostPence", () => {
  it("multiplies the per-channel rate, clamps negatives", () => {
    expect(estimateCostPence("email", 100)).toBe(0);
    expect(estimateCostPence("sms", 10)).toBe(CHANNEL_COST_PENCE.sms * 10);
    expect(estimateCostPence("whatsapp", 3)).toBe(CHANNEL_COST_PENCE.whatsapp * 3);
    expect(estimateCostPence("sms", -5)).toBe(0);
  });
});

describe("retentionCutoff", () => {
  it("is exactly 24 months before now (UTC, no day overflow)", () => {
    expect(CAMPAIGN_SEND_RETENTION_MONTHS).toBe(24);
    // 24 months back from mid-June 2026 = mid-June 2024.
    expect(retentionCutoff(new Date("2026-06-15T12:00:00Z")).toISOString()).toBe(
      "2024-06-15T12:00:00.000Z",
    );
  });

  it("handles a January boundary across the year", () => {
    expect(retentionCutoff(new Date("2026-01-31T00:00:00Z")).getUTCFullYear()).toBe(2024);
    expect(retentionCutoff(new Date("2026-01-31T00:00:00Z")).getUTCMonth()).toBe(0); // January
  });
});
