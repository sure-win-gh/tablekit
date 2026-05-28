import { describe, expect, it } from "vitest";

import { noShowCluster } from "@/lib/services/suggestions/no-show-cluster";
import { oversoldRisk } from "@/lib/services/suggestions/oversold-risk";
import { runSuggestions } from "@/lib/services/suggestions/run";
import type { ServiceContext } from "@/lib/services/suggestions/types";
import { underbooked72h } from "@/lib/services/suggestions/underbooked-72h";
import { walkInHeadroom } from "@/lib/services/suggestions/walk-in-headroom";

const NOW = new Date("2026-05-28T10:00:00Z");

// Baseline context that fires no rule — tests override only what they need.
function ctx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    serviceId: "svc",
    utilisation: 0.5,
    startsAt: new Date("2026-06-30T18:00:00Z"), // far future
    now: NOW,
    windowMinutes: 240,
    turnMinutes: 90,
    walkInWeekdayShare: 0,
    noShowProneBookingCount: 0,
    ...overrides,
  };
}

describe("underbooked-72h", () => {
  it("fires when quiet (<30%) and starting within 72h", () => {
    const s = underbooked72h(ctx({ utilisation: 0.2, startsAt: new Date("2026-05-29T18:00:00Z") }));
    expect(s?.rule).toBe("underbooked-72h");
  });

  it("does not fire when starting more than 72h out", () => {
    expect(underbooked72h(ctx({ utilisation: 0.2 }))).toBeNull();
  });

  it("does not fire when already busy", () => {
    expect(
      underbooked72h(ctx({ utilisation: 0.5, startsAt: new Date("2026-05-29T18:00:00Z") })),
    ).toBeNull();
  });

  it("does not fire for a service that has already started", () => {
    expect(
      underbooked72h(ctx({ utilisation: 0.1, startsAt: new Date("2026-05-28T09:00:00Z") })),
    ).toBeNull();
  });
});

describe("oversold-risk", () => {
  it("fires at >=95% with tight turns (slack < 30)", () => {
    // 240 % 90 = 60 → not tight; use 200 % 90 = 20 → tight.
    const s = oversoldRisk(ctx({ utilisation: 0.97, windowMinutes: 200, turnMinutes: 90 }));
    expect(s?.rule).toBe("oversold-risk");
  });

  it("does not fire when there is comfortable slack (>= 30)", () => {
    expect(
      oversoldRisk(ctx({ utilisation: 0.97, windowMinutes: 240, turnMinutes: 90 })),
    ).toBeNull();
  });

  it("does not fire below 95%", () => {
    expect(oversoldRisk(ctx({ utilisation: 0.8, windowMinutes: 200, turnMinutes: 90 }))).toBeNull();
  });
});

describe("walk-in-headroom", () => {
  it("fires when quiet (<60%) and walk-in share is high (>25%)", () => {
    const s = walkInHeadroom(ctx({ utilisation: 0.4, walkInWeekdayShare: 0.3 }));
    expect(s?.rule).toBe("walk-in-headroom");
  });

  it("does not fire when walk-in share is low", () => {
    expect(walkInHeadroom(ctx({ utilisation: 0.4, walkInWeekdayShare: 0.1 }))).toBeNull();
  });

  it("does not fire when already busy", () => {
    expect(walkInHeadroom(ctx({ utilisation: 0.7, walkInWeekdayShare: 0.3 }))).toBeNull();
  });
});

describe("no-show-cluster", () => {
  it("fires at 3+ prior-no-show bookings", () => {
    expect(noShowCluster(ctx({ noShowProneBookingCount: 3 }))?.rule).toBe("no-show-cluster");
  });

  it("does not fire below 3", () => {
    expect(noShowCluster(ctx({ noShowProneBookingCount: 2 }))).toBeNull();
  });
});

describe("runSuggestions — priority / first-wins", () => {
  it("returns at most one suggestion, highest priority first", () => {
    // Context that satisfies BOTH oversold-risk and no-show-cluster.
    // oversold-risk is higher priority → it wins.
    const s = runSuggestions(
      ctx({ utilisation: 0.97, windowMinutes: 200, turnMinutes: 90, noShowProneBookingCount: 5 }),
    );
    expect(s?.rule).toBe("oversold-risk");
  });

  it("falls through to a lower-priority rule when higher ones don't fire", () => {
    const s = runSuggestions(ctx({ utilisation: 0.2, startsAt: new Date("2026-05-29T18:00:00Z") }));
    expect(s?.rule).toBe("underbooked-72h");
  });

  it("returns null when nothing fires", () => {
    expect(runSuggestions(ctx())).toBeNull();
  });
});
