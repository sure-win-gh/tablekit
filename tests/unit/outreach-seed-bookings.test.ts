// Unit tests for the pure planner half of lib/outreach/seed-bookings.ts.
// The DB-touching executor is exercised end-to-end via manual smoke;
// here we only verify the distribution math, which is the part that
// could quietly drift if someone tunes DAILY_QUOTA or turn windows.

import { describe, expect, it } from "vitest";

import {
  planSampleBookings,
  type ServiceInput,
  type TableInput,
} from "@/lib/outreach/seed-bookings";

// Deterministic LCG so test assertions are stable. Good enough for a
// PRNG — we're not crypto-testing.
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// 2026-05-25 is a Monday — let the planner run Mon..Sun cleanly.
const MONDAY = new Date(Date.UTC(2026, 4, 25, 9, 0, 0));

const RESTAURANT_SERVICES: ServiceInput[] = [
  {
    id: "svc-lunch",
    schedule: {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      start: "12:00",
      end: "15:00",
    },
    turnMinutes: 90,
  },
  {
    id: "svc-dinner",
    schedule: {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      start: "18:00",
      end: "22:00",
    },
    turnMinutes: 90,
  },
];

const SIX_TABLES: TableInput[] = Array.from({ length: 6 }, (_, i) => ({
  id: `tbl-${i + 1}`,
  areaId: "area-main",
  minCover: 2,
  maxCover: 4,
}));

describe("planSampleBookings", () => {
  it("returns an empty plan when there are no services or no tables", () => {
    expect(planSampleBookings({ services: [], tables: SIX_TABLES, now: MONDAY })).toEqual([]);
    expect(planSampleBookings({ services: RESTAURANT_SERVICES, tables: [], now: MONDAY })).toEqual(
      [],
    );
  });

  it("produces ~15 bookings across the next 7 days with a deterministic seed", () => {
    const plans = planSampleBookings({
      services: RESTAURANT_SERVICES,
      tables: SIX_TABLES,
      now: MONDAY,
      random: seededRandom(42),
    });
    expect(plans.length).toBeGreaterThanOrEqual(12);
    expect(plans.length).toBeLessThanOrEqual(15);
  });

  it("never schedules a booking outside its service window", () => {
    const plans = planSampleBookings({
      services: RESTAURANT_SERVICES,
      tables: SIX_TABLES,
      now: MONDAY,
      random: seededRandom(7),
    });
    for (const p of plans) {
      const startHour = p.startAt.getUTCHours() + p.startAt.getUTCMinutes() / 60;
      const endHour = p.endAt.getUTCHours() + p.endAt.getUTCMinutes() / 60;
      // Booking starts inside one of the windows.
      const inLunch = startHour >= 12 && endHour <= 15;
      const inDinner = startHour >= 18 && endHour <= 22;
      expect(inLunch || inDinner).toBe(true);
    }
  });

  it("never overlaps two bookings on the same table", () => {
    const plans = planSampleBookings({
      services: RESTAURANT_SERVICES,
      tables: SIX_TABLES,
      now: MONDAY,
      random: seededRandom(101),
    });
    // Walk each table's intervals and assert no pair overlaps.
    // Catches the 12:00–13:30 vs 12:15–13:45 case the cheap
    // start-time-equality check would miss.
    const byTable = new Map<string, Array<[number, number]>>();
    for (const p of plans) {
      const xs = byTable.get(p.tableId) ?? [];
      xs.push([p.startAt.getTime(), p.endAt.getTime()]);
      byTable.set(p.tableId, xs);
    }
    for (const xs of byTable.values()) {
      xs.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]![0]).toBeGreaterThanOrEqual(xs[i - 1]![1]);
      }
    }
  });

  it("respects party-size bounds against the chosen table", () => {
    const plans = planSampleBookings({
      services: RESTAURANT_SERVICES,
      tables: SIX_TABLES,
      now: MONDAY,
      random: seededRandom(2),
    });
    for (const p of plans) {
      expect(p.partySize).toBeGreaterThanOrEqual(2); // min(2, table.minCover)
      expect(p.partySize).toBeLessThanOrEqual(4); // table.maxCover capped at 4
    }
  });

  it("weights Fri/Sat more heavily than midweek (sanity)", () => {
    // Many seeds so we average out single-run noise.
    let weekendTotal = 0;
    let midweekTotal = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const plans = planSampleBookings({
        services: RESTAURANT_SERVICES,
        tables: SIX_TABLES,
        now: MONDAY,
        random: seededRandom(seed),
      });
      for (const p of plans) {
        const day = p.startAt.getUTCDay(); // 5=Fri, 6=Sat (UTC anchor — MONDAY is at 09:00 UTC)
        if (day === 5 || day === 6) weekendTotal++;
        else midweekTotal++;
      }
    }
    // Fri+Sat quota is 7/day; weekday quota is 1-2/day. Expect
    // weekendTotal > midweekTotal / 2 across the run.
    expect(weekendTotal).toBeGreaterThan(midweekTotal / 2);
  });

  it("skips days where no service applies", () => {
    const weekdayOnly: ServiceInput[] = [
      {
        id: "svc-weekday",
        schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "12:00", end: "14:00" },
        turnMinutes: 60,
      },
    ];
    const plans = planSampleBookings({
      services: weekdayOnly,
      tables: SIX_TABLES,
      now: MONDAY,
      random: seededRandom(99),
    });
    for (const p of plans) {
      // 5=Fri, 6=Sat, 0=Sun in JS getUTCDay
      expect([6, 0]).not.toContain(p.startAt.getUTCDay());
    }
  });
});
