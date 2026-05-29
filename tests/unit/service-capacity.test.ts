import { describe, expect, it } from "vitest";

import { resolveCapacity } from "@/lib/services/capacity";

describe("resolveCapacity", () => {
  it("uses the override when present", () => {
    expect(resolveCapacity(120, 40)).toBe(40);
  });

  it("falls back to room capacity when override is null/undefined", () => {
    expect(resolveCapacity(120, null)).toBe(120);
    expect(resolveCapacity(120, undefined)).toBe(120);
  });

  it("honours an override of a larger number (operators may run extra covers)", () => {
    expect(resolveCapacity(120, 150)).toBe(150);
  });

  it("treats a zero room capacity (no tables) as zero when no override", () => {
    expect(resolveCapacity(0, undefined)).toBe(0);
  });
});
