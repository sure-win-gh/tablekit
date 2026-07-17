import { describe, expect, it } from "vitest";

import { FEATURES, isLocked, type Feature } from "@/lib/auth/entitlements";
import { hasPlan, type Plan } from "@/lib/auth/plan-level";

const ALL_PLANS: Plan[] = ["free", "core", "plus"];
const ALL_FEATURES = Object.keys(FEATURES) as Feature[];

describe("FEATURES map", () => {
  it("gives every feature a known min plan, label and blurb", () => {
    for (const f of ALL_FEATURES) {
      const meta = FEATURES[f];
      expect(ALL_PLANS).toContain(meta.minPlan);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.blurb.length).toBeGreaterThan(0);
    }
  });

  it("matches the commercial ladder: Core for deposits/messaging/campaigns, Plus for the rest", () => {
    expect(FEATURES.deposits.minPlan).toBe("core");
    expect(FEATURES.messaging.minPlan).toBe("core");
    // Campaigns unlock at Core (email broadcasts with an allowance); the
    // SMS/WhatsApp channels + audience segments are gated Plus inside the
    // feature, not on this map. See docs/specs/email-broadcast-billing.md.
    expect(FEATURES.campaigns.minPlan).toBe("core");
    for (const f of ["enquiries", "insights", "serviceSummary", "crm", "apiKeys"] as const) {
      expect(FEATURES[f].minPlan).toBe("plus");
    }
  });
});

describe("isLocked", () => {
  it("is the negation of hasPlan against the feature's min plan", () => {
    for (const plan of ALL_PLANS) {
      for (const f of ALL_FEATURES) {
        expect(isLocked(plan, f)).toBe(!hasPlan(plan, FEATURES[f].minPlan));
      }
    }
  });

  it("locks Plus features for free + core, unlocks for plus", () => {
    expect(isLocked("free", "insights")).toBe(true);
    expect(isLocked("core", "insights")).toBe(true);
    expect(isLocked("plus", "insights")).toBe(false);
  });

  it("locks Core features only for free", () => {
    expect(isLocked("free", "deposits")).toBe(true);
    expect(isLocked("core", "deposits")).toBe(false);
    expect(isLocked("plus", "deposits")).toBe(false);
  });
});
