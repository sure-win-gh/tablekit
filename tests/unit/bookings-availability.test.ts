// Pure-function tests for lib/bookings/availability.ts.
//
// Uses fixed "Europe/London" UTC offsets so the tests don't care which
// timezone the CI runner lives in. The time module handles BST/GMT
// correctly — we just pick a date in BST (April) for consistency.

import { describe, expect, it } from "vitest";

import { findSlots, type ServiceSpec, type TableSpec } from "@/lib/bookings/availability";

const TZ = "Europe/London";
const DATE = "2026-05-10"; // Sunday, BST so UTC+1

const cafeService: ServiceSpec = {
  id: "svc-1",
  name: "Open",
  schedule: {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "08:00",
    end: "17:00",
  },
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
      tables: [t("T1", "A", 1, 2), t("T2", "A", 1, 4), t("T3", "A", 1, 6), t("T4", "A", 1, 6)],
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

// Operator-controlled joins (docs/specs/table-combining.md). All tables
// below are 2-tops so no single seats a party >= 3 — combinations are
// always exercised. `edge` builds a symmetric join edge.
const edge = (a: string, b: string) => ({ aId: a, bId: b });

// Occupy a table across the whole cafe service window on DATE so it is
// never free for any slot.
const occupyAllDay = (tableId: string) => ({
  tableId,
  startAt: new Date("2026-05-10T00:00:00+01:00"),
  endAt: new Date("2026-05-10T23:59:00+01:00"),
});

const firstOptions = (input: Parameters<typeof findSlots>[0]) => {
  const slots = findSlots(input);
  return slots[0]?.options ?? [];
};

const hasSet = (opts: { tableIds: string[] }[], ids: string[]) =>
  opts.some((o) => o.tableIds.length === ids.length && ids.every((id) => o.tableIds.includes(id)));

describe("findSlots — operator join graph", () => {
  const chain = [t("T1", "A", 1, 2), t("T2", "A", 1, 2), t("T3", "A", 1, 2), t("T4", "A", 1, 2)];
  const chainEdges = [edge("T1", "T2"), edge("T2", "T3"), edge("T3", "T4")];

  it("offers a connected 3-table set for a party of 6 (all free)", () => {
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: chain,
      occupied: [],
      combinable: chainEdges,
    });
    // {1,2,3} and {2,3,4} both seat 6; {1,2,3,4} also fits but is ranked
    // after (more tables). Fewest-tables-first ⇒ a 3-set leads.
    expect(opts[0]!.tableIds.length).toBe(3);
    expect(hasSet(opts, ["T1", "T2", "T3"])).toBe(true);
  });

  it("scenario A: table 3 taken ⇒ {1,2,4} is never offered (4 needs 3 to connect)", () => {
    // Party of 4 now needs a pair. Free = {1,2,4}; only 1-2 stay connected.
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 4,
      services: [cafeService],
      tables: chain,
      occupied: [occupyAllDay("T3")],
      combinable: chainEdges,
    });
    expect(hasSet(opts, ["T1", "T2"])).toBe(true);
    // 4 is stranded — no option pairs it with 1 or 2.
    expect(opts.some((o) => o.tableIds.includes("T4"))).toBe(false);
  });

  it("scenario A: table 3 taken ⇒ a party needing 3 tables can't be seated", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: chain,
      occupied: [occupyAllDay("T3")],
      combinable: chainEdges,
    });
    // Remaining connected components ({1,2} and {4}) top out at 4 covers.
    expect(slots).toEqual([]);
  });

  it("scenario B: hub layout, table 7 taken ⇒ {5,6,8} still combines", () => {
    const hub = [t("T5", "A", 1, 2), t("T6", "A", 1, 2), t("T7", "A", 1, 2), t("T8", "A", 1, 2)];
    const hubEdges = [edge("T5", "T6"), edge("T6", "T7"), edge("T6", "T8"), edge("T7", "T8")];
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: hub,
      occupied: [occupyAllDay("T7")],
      combinable: hubEdges,
    });
    // 5-6-8 is still a connected path (via 6) ⇒ offered.
    expect(hasSet(opts, ["T5", "T6", "T8"])).toBe(true);
  });

  it("is per-area: wiring area A doesn't disable legacy pairing in area B", () => {
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: [
        t("A1", "A", 1, 2),
        t("A2", "A", 1, 2),
        t("A3", "A", 1, 2),
        t("B1", "B", 1, 2),
        t("B2", "B", 1, 4), // B has no edges → legacy any-pair
      ],
      occupied: [],
      combinable: [edge("A1", "A2"), edge("A2", "A3")], // only area A configured
    });
    expect(hasSet(opts, ["A1", "A2", "A3"])).toBe(true); // graph triple in A
    expect(hasSet(opts, ["B1", "B2"])).toBe(true); // legacy pair still in B
  });

  it("respects maxCombineTables", () => {
    const base = {
      timezone: TZ,
      date: DATE,
      partySize: 8, // needs all four 2-tops
      services: [cafeService],
      tables: chain,
      occupied: [],
      combinable: chainEdges,
    };
    expect(findSlots({ ...base, maxCombineTables: 3 })).toEqual([]); // 3 tables = 6 < 8
    expect(hasSet(firstOptions({ ...base, maxCombineTables: 4 }), ["T1", "T2", "T3", "T4"])).toBe(
      true,
    );
  });

  it("ranks fewest-tables-then-least-waste", () => {
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 4, // a pair suffices
      services: [cafeService],
      tables: chain,
      occupied: [],
      combinable: chainEdges,
    });
    // Pairs (2 tables) must precede any triple.
    expect(opts[0]!.tableIds.length).toBe(2);
  });

  it("drops a cross-area edge (defensive load-time filter)", () => {
    const slots = findSlots({
      timezone: TZ,
      date: DATE,
      partySize: 4,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2), t("T2", "B", 1, 2)],
      occupied: [],
      combinable: [edge("T1", "T2")], // spans areas → ignored
    });
    expect(slots).toEqual([]);
  });

  it("ignores an edge to an unknown table", () => {
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 3,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2), t("T2", "A", 1, 2)],
      occupied: [],
      combinable: [edge("T1", "GHOST"), edge("T1", "T2")],
    });
    // The valid 1-2 edge still forms a pair (max 4 seats 3); no crash.
    expect(hasSet(opts, ["T1", "T2"])).toBe(true);
  });

  it("does not truncate a legacy area's pairs when another area is configured", () => {
    // Area B has 8 two-tops and no edges → 28 legacy pairs, more than the
    // per-slot cap. Configuring area A must not drop any of B's pairs.
    const bTables = Array.from({ length: 8 }, (_, i) => t(`B${i}`, "B", 1, 2));
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 4, // needs a pair; no single 2-top fits
      services: [cafeService],
      tables: [t("A1", "A", 1, 2), t("A2", "A", 1, 2), ...bTables],
      occupied: [],
      combinable: [edge("A1", "A2")], // area A configured, area B not
    });
    const bPairs = opts.filter(
      (o) => o.tableIds.length === 2 && o.tableIds.every((id) => id.startsWith("B")),
    );
    expect(bPairs.length).toBe(28); // C(8,2) — none truncated
  });

  it("a dense configured area offers only edge-pairs, never all same-area pairs", () => {
    // 15 tables (> DENSE_AREA_TABLE_LIMIT) in a configured area with a
    // single edge. The degraded path must stay edge-restricted, not fall
    // back to any-same-area pairing.
    const many = Array.from({ length: 15 }, (_, i) => t(`D${i}`, "A", 1, 2));
    const opts = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 4,
      services: [cafeService],
      tables: many,
      occupied: [],
      combinable: [edge("D0", "D1")], // configures area A; only D0-D1 join
    });
    expect(opts.length).toBe(1);
    expect(hasSet(opts, ["D0", "D1"])).toBe(true);
  });

  it("empty combinable behaves exactly like legacy pairs", () => {
    const legacy = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2), t("T2", "A", 1, 4)],
      occupied: [],
    });
    const withEmpty = firstOptions({
      timezone: TZ,
      date: DATE,
      partySize: 6,
      services: [cafeService],
      tables: [t("T1", "A", 1, 2), t("T2", "A", 1, 4)],
      occupied: [],
      combinable: [],
    });
    expect(withEmpty).toEqual(legacy);
  });
});

// Special-event closures (docs/specs/special-events.md). A closure window
// blocks any standard slot whose [startAt, endAt) overlaps it. Dates use
// the same BST day so the UTC offset is +1.
describe("findSlots — special-event closures", () => {
  // Café 08:00–17:00, 45-min turn. A slot at wall "HH:MM" spans
  // [HH:MM, HH:MM+45m) venue-local (UTC+1 on 2026-05-10).
  const base = {
    timezone: TZ,
    date: DATE,
    partySize: 2,
    services: [cafeService],
    tables: [t("T1", "A", 1, 2)],
    occupied: [],
  };

  // Helper: venue-local wall time on DATE as a UTC Date (BST → -1h).
  const utc = (hhmm: string) => new Date(`${DATE}T${hhmm}:00+01:00`);

  it("omitted closures is byte-identical to before the feature", () => {
    const withoutKey = findSlots({ ...base });
    const withEmpty = findSlots({ ...base, closures: [] });
    expect(withEmpty).toEqual(withoutKey);
    expect(withEmpty.length).toBe(34);
  });

  it("a whole-day closure removes every slot", () => {
    const slots = findSlots({
      ...base,
      closures: [{ startAt: utc("00:00"), endAt: utc("23:59") }],
    });
    expect(slots).toEqual([]);
  });

  it("a lunchtime window only removes overlapping slots", () => {
    // Closure 12:00–14:00. A 45-min slot overlaps iff it starts in
    // (11:15, 14:00): first blocked start is 11:30, last blocked is 13:45.
    const slots = findSlots({
      ...base,
      closures: [{ startAt: utc("12:00"), endAt: utc("14:00") }],
    });
    const starts = slots.map((s) => s.wallStart);
    expect(starts).toContain("11:15"); // ends 12:00 exactly — half-open, allowed
    expect(starts).not.toContain("11:30"); // ends 12:15 — overlaps
    expect(starts).not.toContain("13:45"); // starts inside the window
    expect(starts).toContain("14:00"); // starts exactly at close — allowed
  });

  it("half-open: a closure touching a slot's edge does not block it", () => {
    // Closure exactly over the 09:00 slot window [09:00, 09:45).
    const slots = findSlots({
      ...base,
      closures: [{ startAt: utc("09:00"), endAt: utc("09:45") }],
    });
    const starts = slots.map((s) => s.wallStart);
    expect(starts).not.toContain("09:00"); // identical window — overlaps
    expect(starts).toContain("08:15"); // ends 09:00 — touches, allowed
    expect(starts).toContain("09:45"); // starts 09:45 — touches, allowed
  });

  it("multiple closures each remove their own window", () => {
    const slots = findSlots({
      ...base,
      closures: [
        { startAt: utc("08:00"), endAt: utc("09:00") },
        { startAt: utc("15:00"), endAt: utc("17:00") },
      ],
    });
    const starts = slots.map((s) => s.wallStart);
    expect(starts).not.toContain("08:00");
    expect(starts).not.toContain("15:00");
    expect(starts).toContain("12:00"); // untouched midday slot survives
  });
});

// Area-scoped closures (docs/specs/special-events.md §Area-scoped events).
// A closure with areaIds removes only those areas' tables from the free
// set; whole-venue (areaIds null/empty) drops the slot outright — the
// degenerate "every area" case of the same rule.
describe("findSlots — area-scoped closures", () => {
  const utc = (hhmm: string) => new Date(`${DATE}T${hhmm}:00+01:00`);
  const base = {
    timezone: TZ,
    date: DATE,
    partySize: 2,
    services: [cafeService],
    tables: [t("TA", "A", 1, 2), t("TB", "B", 1, 2)],
    occupied: [],
  };
  const scoped = (areaIds: string[] | null) => [
    { startAt: utc("12:00"), endAt: utc("14:00"), areaIds },
  ];

  it("a closure scoped to area A leaves area B bookable in the window", () => {
    const slots = findSlots({ ...base, closures: scoped(["A"]) });
    const at1230 = slots.find((s) => s.wallStart === "12:30");
    expect(at1230).toBeDefined();
    const tables = at1230!.options.flatMap((o) => o.tableIds);
    expect(tables).toContain("TB");
    expect(tables).not.toContain("TA");
    // Outside the window, area A is back.
    const at0900 = slots.find((s) => s.wallStart === "09:00");
    expect(at0900!.options.flatMap((o) => o.tableIds)).toContain("TA");
  });

  it("scoping every area ≡ whole-venue: the slot disappears", () => {
    const slots = findSlots({ ...base, closures: scoped(["A", "B"]) });
    expect(slots.map((s) => s.wallStart)).not.toContain("12:30");
  });

  it("areaIds null and areaIds [] both mean whole venue", () => {
    for (const areaIds of [null, [] as string[]]) {
      const slots = findSlots({ ...base, closures: scoped(areaIds) });
      expect(slots.map((s) => s.wallStart)).not.toContain("12:30");
      expect(slots.map((s) => s.wallStart)).toContain("09:00");
    }
  });

  it("same-area combinations die with their scoped area", () => {
    // Party of 3 seats only via the A1+A2 pair; TB (max 2) can't hold it.
    const input = {
      timezone: TZ,
      date: DATE,
      partySize: 3,
      services: [cafeService],
      tables: [t("A1", "A", 1, 2), t("A2", "A", 1, 2), t("TB", "B", 1, 2)],
      occupied: [],
    };
    const open = findSlots({ ...input });
    expect(open.map((s) => s.wallStart)).toContain("12:30");
    const blocked = findSlots({ ...input, closures: scoped(["A"]) });
    expect(blocked.map((s) => s.wallStart)).not.toContain("12:30");
    // The pair returns outside the closure window.
    expect(blocked.map((s) => s.wallStart)).toContain("09:00");
  });
});
