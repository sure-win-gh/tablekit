// timeAgo — the relative-time helper used across admin tables.

import { describe, expect, it } from "vitest";

import { timeAgo } from "@/components/admin/ui";

const NOW = new Date("2026-07-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("timeAgo", () => {
  it("renders — for null", () => {
    expect(timeAgo(null, NOW)).toBe("—");
  });

  it("clamps future and sub-minute values to 'just now'", () => {
    expect(timeAgo(ago(-5_000), NOW)).toBe("just now");
    expect(timeAgo(ago(30_000), NOW)).toBe("just now");
  });

  it("steps through minutes, hours, days, months, years", () => {
    expect(timeAgo(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(timeAgo(ago(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(timeAgo(ago(2 * 86_400_000), NOW)).toBe("2d ago");
    expect(timeAgo(ago(65 * 86_400_000), NOW)).toBe("2mo ago");
    expect(timeAgo(ago(400 * 86_400_000), NOW)).toBe("1y ago");
  });

  it("uses boundary units correctly", () => {
    expect(timeAgo(ago(59 * 60_000), NOW)).toBe("59m ago");
    expect(timeAgo(ago(60 * 60_000), NOW)).toBe("1h ago");
    expect(timeAgo(ago(23 * 3_600_000), NOW)).toBe("23h ago");
    expect(timeAgo(ago(24 * 3_600_000), NOW)).toBe("1d ago");
  });
});
