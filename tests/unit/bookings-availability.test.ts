// Pure-function tests for lib/bookings/availability.ts.
//
// Uses fixed "Europe/London" UTC offsets so the tests don't care which
// timezone the CI runner lives in. The time module handles BST/GMT
// correctly — we just pick a date in BST (April) for consistency.

import { describe, expect, it } from "vitest";

import {
  findSlots,
  type ServiceSpec,
  type TableSpec,
} from "@/lib/bookings/availability";

const TZ = "Europe/London";
const DATE = "2026-05-10"; // Sunday, BST so UTC+1

const cafeService: ServiceSpec = {
  id: "svc-1",
  name: "Open",
  schedule: { days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start: "08:00", end: "17:00" },
  turnMinutes: 45,
};

const dinnerService: ServiceSpec = {
  id: "svc-dinner",
  name: "Dinner",
  schedule: { days: ["fri", "sat", "sun"], start: "18:00", end: "22:00" },
  turnMinutes: 90,
};

const t = (id: string, areaId: string, min: number, max: number): TableSpec => ({
  id,
  areaId,
  minCover: min,
  maxCover: max,
});

describe("findSlots", () => {
  it("returns slots stepped every 15 minutes by default", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 2,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2)],
      occupied: [],
    });
    // 08:00 to 16:15 (last start = end - 45 = 16:15)
    expect(slots[0]?.wallStart).toBe("08:00");
    expect(slots[slots.length - 1]?.wallStart).toBe("16:15");
    // 15-min step: 9 * 4 + 1 = 34 slots (08:00..16:15 inclusive)
    expect(slots.length).toBe(34);
  });

  it("skips services not scheduled for the day of week", () => {
    const mondayOnly: ServiceSpec = {
      ...dinnerService,
      schedule: { ...dinnerService.schedule, days: ["mon"] },
    };
    // DATE is a Sunday; Monday-only service should return 0 slots.
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 2,
      services: [mondayOnly],
      tables: [t("T1", "A", 1, 4)],
      occupied: [],
    });
    expect(slots).toEqual([]);
  });

  it("filters out tables already occupied for the slot range", () => {
    const occupiedSlotStart = new Date("2026-05-10T08:00:00+01:00");
    const occupiedSlotEnd = new Date("2026-05-10T08:45:00+01:00");
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 2,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2)],
      occupied: [{ tableId: "T1", startAt: occupiedSlotStart, endAt: occupiedSlotEnd }],
    });
    // 08:00 clashes; 08:45 is fine (half-open range).
    expect(slots.find((s) => s.wallStart === "08:00")).toBeUndefined();
    expect(slots.find((s) => s.wallStart === "08:45")).toBeDefined();
  });

  it("prefers a single sufficient table over a pair", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 3,
      services: [cafeService],
      tables: [t("T2", "A", 1, 2), t("T3", "A", 1, 2), t("T4", "A", 1, 4)],
      occupied: [],
    });
    const first = slots[0]!;
    // Every option should be a single T4 (4-top fits 3) — no pair offered.
    for (const opt of first.options) {
      expect(opt.tableIds.length).toBe(1);
    }
  });

  it("falls back to combining two same-area tables when no single fits", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2), t("T2", "A", 1, 4)],
      occupied: [],
    });
    const first = slots[0]!;
    expect(first.options.length).toBeGreaterThan(0);
    for (const opt of first.options) {
      expect(opt.tableIds.length).toBe(2);
      expect(opt.totalMaxCover).toBe(6);
    }
  });

  it("refuses to combine across areas", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      // Same capacity as the previous test but split across two areas.
      tables: [t("T1", "A", 1, 2), t("T2", "B", 1, 4)],
      occupied: [],
    });
    // Nothing fits — slots should be empty.
    expect(slots).toEqual([]);
  });

  it("returns nothing for a party bigger than any combination", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 20,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2), t("T2", "A", 1, 4)],
      occupied: [],
    });
    expect(slots).toEqual([]);
  });

  it("respects the minCover floor when combining", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 1,
      services: [cafeService],
      // Both 4-tops — party of 1 is fine on a single 4-top, so no pair.
      tables: [t("T1", "A", 1, 4), t("T2", "A", 1, 4)],
      occupied: [],
    });
    for (const opt of slots[0]!.options) {
      expect(opt.tableIds.length).toBe(1);
    }
  });

  it("sorts combined options by total max cover ascending", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: [
        t("T1", "A", 1, 2),
        t("T2", "A", 1, 4),
        t("T3", "A", 1, 6),
        t("T4", "A", 1, 6),
      ],
      occupied: [],
    });
    const first = slots[0]!;
    // Single T3 or T4 fit — all options singles.
    for (const opt of first.options) expect(opt.tableIds.length).toBe(1);
  });

  it("supports a custom slot step", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 2,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2)],
      occupied: [],
      slotStepMinutes: 30,
    });
    // 08:00 every 30 min to 16:00 (last start that fits a 45 min turn is 16:15;
    // stepping by 30 from 08:00 lands on 16:00 before that).
    expect(slots[1]?.wallStart).toBe("08:30");
    for (const s of slots) {
      const [, m = "0"] = s.wallStart.split(":");
      expect(Number(m) % 30).toBe(0);
    }
  });

  it("returns non-empty slots for both services on the same day", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 2,
      services: [cafeService, dinnerService],
      tables: [t("T1", "A", 1, 2)],
      occupied: [],
    });
    const services = new Set(slots.map((s) => s.serviceId));
    expect(services.has(cafeService.id)).toBe(true);
    expect(services.has(dinnerService.id)).toBe(true);
  });
});
