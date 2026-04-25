// Unit tests for the wait-time estimator.

import { describe, expect, it } from "vitest";

import { WAIT_CAP_MINUTES, estimateWaitMinutes, formatWaitMinutes } from "@/lib/waitlist/wait-time";

describe("estimateWaitMinutes", () => {
  it("returns 0 for an out-of-range position", () => {
    expect(estimateWaitMinutes({ position: 0, avgTurnMinutes: 60 })).toBe(0);
    expect(estimateWaitMinutes({ position: -1, avgTurnMinutes: 60 })).toBe(0);
  });

  it("multiplies position by avg turn", () => {
    expect(estimateWaitMinutes({ position: 1, avgTurnMinutes: 30 })).toBe(30);
    expect(estimateWaitMinutes({ position: 2, avgTurnMinutes: 30 })).toBe(60);
  });

  it("caps at WAIT_CAP_MINUTES", () => {
    expect(estimateWaitMinutes({ position: 5, avgTurnMinutes: 30 })).toBe(WAIT_CAP_MINUTES);
    expect(estimateWaitMinutes({ position: 100, avgTurnMinutes: 60 })).toBe(WAIT_CAP_MINUTES);
  });
});

describe("formatWaitMinutes", () => {
  it("returns 'now' for zero or negative", () => {
    expect(formatWaitMinutes(0)).toBe("now");
    expect(formatWaitMinutes(-5)).toBe("now");
  });

  it("formats minutes-only when under an hour", () => {
    expect(formatWaitMinutes(5)).toBe("5 min");
    expect(formatWaitMinutes(45)).toBe("45 min");
  });

  it("formats whole hours without minutes", () => {
    expect(formatWaitMinutes(60)).toBe("1h");
    expect(formatWaitMinutes(120)).toBe("2h");
  });

  it("formats hours + minutes", () => {
    expect(formatWaitMinutes(75)).toBe("1h 15m");
    expect(formatWaitMinutes(90)).toBe("1h 30m");
  });
});
