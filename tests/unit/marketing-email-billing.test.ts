// Unit tests for the marketing-email allowance + overage costing.
// docs/specs/email-broadcast-billing.md acceptance criteria: rounding at
// 0/1/999/1000/1001 chargeable at both plan rates, allowance boundaries,
// and UTC month bounds.

import { describe, expect, it } from "vitest";

import {
  MARKETING_EMAIL,
  emailCampaignCostPence,
  emailChargeableCount,
  monthBoundsUtc,
} from "@/lib/billing/marketing-email";

const CORE = MARKETING_EMAIL.overagePencePer1000.core; // 100 = £1.00/1,000
const PLUS = MARKETING_EMAIL.overagePencePer1000.plus; // 90 = £0.90/1,000

describe("MARKETING_EMAIL commercials", () => {
  it("matches the agreed allowances and rates", () => {
    expect(MARKETING_EMAIL.allowancePerMonth).toEqual({ free: 0, core: 500, plus: 2500 });
    expect(MARKETING_EMAIL.overagePencePer1000).toEqual({ free: 0, core: 100, plus: 90 });
  });
});

describe("emailChargeableCount", () => {
  it("is zero while within the allowance", () => {
    expect(emailChargeableCount(0, 500)).toBe(0);
    expect(emailChargeableCount(500, 500)).toBe(0);
  });
  it("charges only the excess", () => {
    expect(emailChargeableCount(501, 500)).toBe(1);
    expect(emailChargeableCount(3200, 2500)).toBe(700);
  });
  it("treats a negative/exhausted allowance as zero remaining", () => {
    expect(emailChargeableCount(10, 0)).toBe(10);
    expect(emailChargeableCount(10, -5)).toBe(10);
  });
});

describe("emailCampaignCostPence — rounds UP to whole pence", () => {
  it("charges nothing for zero chargeable", () => {
    expect(emailCampaignCostPence(0, 0, PLUS)).toBe(0);
    expect(emailCampaignCostPence(2500, 2500, PLUS)).toBe(0);
  });
  it("Plus rate (90p/1,000): 1 → 1p, 999 → 90p, 1000 → 90p, 1001 → 91p", () => {
    expect(emailCampaignCostPence(1, 0, PLUS)).toBe(1); // ceil(0.09p)
    expect(emailCampaignCostPence(999, 0, PLUS)).toBe(90); // ceil(89.91)
    expect(emailCampaignCostPence(1000, 0, PLUS)).toBe(90);
    expect(emailCampaignCostPence(1001, 0, PLUS)).toBe(91); // ceil(90.09)
  });
  it("Core rate (£1.00/1,000): 1 → 1p, 999 → 100p, 1000 → 100p, 1001 → 101p", () => {
    expect(emailCampaignCostPence(1, 0, CORE)).toBe(1);
    expect(emailCampaignCostPence(999, 0, CORE)).toBe(100); // ceil(99.9)
    expect(emailCampaignCostPence(1000, 0, CORE)).toBe(100);
    expect(emailCampaignCostPence(1001, 0, CORE)).toBe(101);
  });
  it("applies the allowance before pricing (spec example: 3,200 audience, 2,500 allowance ≈ £0.63)", () => {
    expect(emailCampaignCostPence(3200, 2500, PLUS)).toBe(63); // ceil(700×0.09)
  });
  it("reconcile parity: costing the actual sent count with the same snapshot never exceeds the reserve", () => {
    const reserved = emailCampaignCostPence(3200, 2500, PLUS);
    for (const sent of [0, 1, 700, 2500, 3199, 3200]) {
      expect(emailCampaignCostPence(sent, 2500, PLUS)).toBeLessThanOrEqual(reserved);
    }
  });
  it("a zero rate (free plan / flag off) always costs zero", () => {
    expect(emailCampaignCostPence(10_000, 0, 0)).toBe(0);
  });
});

describe("monthBoundsUtc", () => {
  it("brackets a mid-month moment to the UTC calendar month", () => {
    const { start, end } = monthBoundsUtc(new Date("2026-07-07T10:30:00Z"));
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
  it("handles the December → January year rollover", () => {
    const { start, end } = monthBoundsUtc(new Date("2026-12-31T23:59:59Z"));
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("the first instant of a month belongs to that month", () => {
    const { start } = monthBoundsUtc(new Date("2026-07-01T00:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});
