import { describe, expect, it } from "vitest";

import { hasPlan, planLevel, toPlan, type Plan } from "@/lib/auth/plan-level";

describe("planLevel ordering", () => {
  it("orders free < core < plus", () => {
    expect(planLevel.free).toBeLessThan(planLevel.core);
    expect(planLevel.core).toBeLessThan(planLevel.plus);
  });
});

describe("hasPlan", () => {
  const plans: Plan[] = ["free", "core", "plus"];

  it("a plan satisfies its own minimum", () => {
    for (const p of plans) {
      expect(hasPlan(p, p)).toBe(true);
    }
  });

  it("higher plans satisfy lower minimums", () => {
    expect(hasPlan("plus", "free")).toBe(true);
    expect(hasPlan("plus", "core")).toBe(true);
    expect(hasPlan("core", "free")).toBe(true);
  });

  it("lower plans do not satisfy higher minimums", () => {
    expect(hasPlan("free", "core")).toBe(false);
    expect(hasPlan("free", "plus")).toBe(false);
    expect(hasPlan("core", "plus")).toBe(false);
  });
});

describe("toPlan — defensive narrowing", () => {
  it("returns the value when it's a known plan", () => {
    expect(toPlan("free")).toBe("free");
    expect(toPlan("core")).toBe("core");
    expect(toPlan("plus")).toBe("plus");
  });

  it("falls back to 'free' for unknown values (fail-closed)", () => {
    // Future-deploy scenario: a new tier 'enterprise' is added to
    // the DB but the running code doesn't know about it. We'd
    // rather withhold access than grant it.
    expect(toPlan("enterprise")).toBe("free");
    expect(toPlan("")).toBe("free");
    expect(toPlan("PLUS")).toBe("free"); // case-sensitive — match the DB CHECK
  });
});
