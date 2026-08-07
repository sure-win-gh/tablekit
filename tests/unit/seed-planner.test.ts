import { describe, expect, it } from "vitest";

import { makeRng, planBookings, type PlanInput } from "../../scripts/seed/planner";

describe("makeRng — seeded RNG", () => {
  it("is deterministic for a given seed and varies across seeds", () => {
    const a = makeRng("v1:2026-08-01");
    const b = makeRng("v1:2026-08-01");
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);

    const c = makeRng("v1:2026-08-02");
    expect(Array.from({ length: 8 }, () => c())).not.toEqual(seqA);
  });
});

const baseInput = (seed: string): PlanInput => ({
  seed,
  todayYMD: "2026-08-01",
  now: new Date("2026-08-01T12:00:00Z"),
  timezone: "Europe/London",
  capacity: 8,
  servicesList: [
    {
      id: "s1",
      name: "Open",
      schedule: {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "08:00",
        end: "17:00",
      },
      turnMinutes: 45,
    },
  ],
  tables: [
    { id: "t1", areaId: "a1", minCover: 2, maxCover: 4 },
    { id: "t2", areaId: "a1", minCover: 2, maxCover: 4 },
  ],
  existingOccupancy: [],
});

describe("planBookings — deterministic given (seed, inputs)", () => {
  it("produces a non-trivial plan", () => {
    expect(planBookings(baseInput("v1:2026-08-01")).length).toBeGreaterThan(0);
  });

  it("is identical for the same seed (idempotent same-day reseed)", () => {
    const first = planBookings(baseInput("v1:2026-08-01"));
    const again = planBookings(baseInput("v1:2026-08-01"));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
  });

  it("differs for a different seed (a new day varies the data)", () => {
    const day1 = planBookings(baseInput("v1:2026-08-01"));
    const day2 = planBookings(baseInput("v1:2026-08-02"));
    expect(JSON.stringify(day2)).not.toBe(JSON.stringify(day1));
  });

  it("only emits valid booking sources", () => {
    const allowed = new Set(["host", "widget", "rwg", "api", "walk-in"]);
    for (const p of planBookings(baseInput("v1:2026-08-01"))) {
      expect(allowed.has(p.source)).toBe(true);
    }
  });
});
