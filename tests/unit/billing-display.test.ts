// Locks the shared billing/account presentation helpers extracted from the
// billing page, so the two surfaces that import them can't drift.

import { describe, expect, it } from "vitest";

import { PLAN_LABEL, PLAN_PRICE, SUBSCRIBED, fmtDate, fmtMoney } from "@/lib/billing/display";

describe("billing display helpers", () => {
  it("labels the three plans", () => {
    expect(PLAN_LABEL["free"]).toBe("Free");
    expect(PLAN_LABEL["core"]).toBe("Core");
    expect(PLAN_LABEL["plus"]).toBe("Plus");
  });

  it("prices paid plans VAT-exclusive", () => {
    expect(PLAN_PRICE["core"]).toBe("£29/month + VAT");
    expect(PLAN_PRICE["plus"]).toBe("£74/month + VAT");
    expect(PLAN_PRICE["free"]).toBeUndefined();
  });

  it("treats active/trialing/past_due as still-subscribed", () => {
    expect(SUBSCRIBED.has("active")).toBe(true);
    expect(SUBSCRIBED.has("trialing")).toBe(true);
    expect(SUBSCRIBED.has("past_due")).toBe(true);
    expect(SUBSCRIBED.has("canceled")).toBe(false);
    expect(SUBSCRIBED.has("incomplete_expired")).toBe(false);
  });

  it("formats pence as pounds with two decimals", () => {
    expect(fmtMoney(0)).toBe("£0.00");
    expect(fmtMoney(2900)).toBe("£29.00");
    expect(fmtMoney(1050)).toBe("£10.50");
  });

  it("formats a UK long date and dashes a null", () => {
    expect(fmtDate(new Date("2026-01-15T00:00:00Z"))).toBe("15 January 2026");
    expect(fmtDate(null)).toBe("—");
  });
});
