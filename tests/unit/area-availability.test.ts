// Pure tests for lib/bookings/area-availability.ts + its composition with
// findSlots (docs/specs/area-preferences.md).

import { describe, expect, it } from "vitest";

import { areaAvailabilityClosures, type LocalDay } from "@/lib/bookings/area-availability";
import { findSlots, type ServiceSpec, type TableSpec } from "@/lib/bookings/availability";

const TZ = "Europe/London";

const day = (ymd: string): LocalDay => ({
  ymd,
  // BST vs GMT offset doesn't matter for these tests — the helper never
  // does timezone maths; it trusts the caller's UTC bounds.
  startUtc: new Date(`${ymd}T00:00:00Z`),
  endUtc: new Date(`${ymd}T24:00:00Z`),
});

const openArea = { id: "A", bookable: true, closedMonths: [] as number[] };

describe("areaAvailabilityClosures", () => {
  it("all-defaults areas emit no windows (regression pin)", () => {
    expect(areaAvailabilityClosures([openArea, { ...openArea, id: "B" }], [day("2026-05-10")])).toEqual(
      [],
    );
  });

  it("bookable=false closes the area every queried day", () => {
    const out = areaAvailabilityClosures(
      [{ id: "A", bookable: false, closedMonths: [] }, { ...openArea, id: "B" }],
      [day("2026-05-10"), day("2026-05-11")],
    );
    expect(out).toHaveLength(2);
    expect(out.every((w) => w.areaIds?.length === 1 && w.areaIds[0] === "A")).toBe(true);
  });

  it("closed_months closes only days in those venue-local months", () => {
    const winter = { id: "A", bookable: true, closedMonths: [11, 12, 1, 2, 3] };
    const nov = areaAvailabilityClosures([winter], [day("2026-11-21")]);
    const may = areaAvailabilityClosures([winter], [day("2026-05-10")]);
    expect(nov).toHaveLength(1);
    expect(nov[0]?.areaIds).toEqual(["A"]);
    expect(may).toEqual([]);
  });

  it("composes with findSlots: a winter-closed terrace books inside only", () => {
    const cafe: ServiceSpec = {
      id: "svc",
      name: "Open",
      schedule: { days: ["sat"], start: "10:00", end: "14:00" },
      turnMinutes: 60,
    };
    const tables: TableSpec[] = [
      { id: "T-in", areaId: "inside", minCover: 1, maxCover: 2 },
      { id: "T-out", areaId: "terrace", minCover: 1, maxCover: 2 },
    ];
    // 2026-11-21 is a Saturday in GMT (UTC+0).
    const ymd = "2026-11-21";
    const closures = areaAvailabilityClosures(
      [
        { id: "inside", bookable: true, closedMonths: [] },
        { id: "terrace", bookable: true, closedMonths: [11, 12, 1, 2, 3] },
      ],
      [{ ymd, startUtc: new Date(`${ymd}T00:00:00Z`), endUtc: new Date(`${ymd}T24:00:00Z`) }],
    );
    const slots = findSlots({
      timezone: TZ,
      date: ymd,
      partySize: 2,
      services: [cafe],
      tables,
      occupied: [],
      closures,
    });
    expect(slots.length).toBeGreaterThan(0);
    const offered = new Set(slots.flatMap((s) => s.options.flatMap((o) => o.tableIds)));
    expect(offered.has("T-in")).toBe(true);
    expect(offered.has("T-out")).toBe(false);
  });
});
