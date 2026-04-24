// Availability engine — the pure function that powers the new-booking
// form's slot picker.
//
// Contract: given a venue's services, tables, existing bookings for a
// day, and a requested party size, return the list of possible start
// times with the table combinations that could hold that party.
//
// Pure — no DB, no clock, no network. The caller loads the three
// inputs in three queries and hands them in. This keeps the function
// unit-testable to 100% and keeps the request path from accidentally
// making N+1 queries.
//
// Combinable-table rule (phase decision): two tables combine iff they
// share an `area_id`. Enforced at the DB layer by a trigger; surfaced
// here by only pairing within the same area.

import {
  dayKeyInZone,
  formatWallHHMM,
  parseWallHHMM,
  zonedWallToUtc,
  type DayKey,
} from "./time";

export type ServiceSpec = {
  id: string;
  name: string;
  schedule: { days: DayKey[]; start: string; end: string };
  turnMinutes: number;
};

export type TableSpec = {
  id: string;
  areaId: string;
  minCover: number;
  maxCover: number;
};

export type Occupancy = {
  tableId: string;
  startAt: Date;
  endAt: Date;
};

export type AvailabilityInput = {
  timezone: string;
  date: string; // YYYY-MM-DD, venue-local
  partySize: number;
  services: ServiceSpec[];
  tables: TableSpec[];
  occupied: Occupancy[];
  slotStepMinutes?: number; // defaults to 15
};

export type TableOption = {
  tableIds: string[];
  totalMaxCover: number;
  totalMinCover: number;
  areaId: string;
};

export type Slot = {
  serviceId: string;
  serviceName: string;
  startAt: Date; // UTC
  endAt: Date; // UTC
  wallStart: string; // "HH:MM" for display
  options: TableOption[];
};

export function findSlots(input: AvailabilityInput): Slot[] {
  const step = input.slotStepMinutes ?? 15;
  const slots: Slot[] = [];

  for (const svc of input.services) {
    // Determine the day-of-week the service runs in the venue's zone
    // at the target date's service-start instant. Using the start-of-
    // -day wouldn't cover overnight services (not supported today).
    const svcStartUtc = zonedWallToUtc(input.date, svc.schedule.start, input.timezone);
    const dayOfDate = dayKeyInZone(svcStartUtc, input.timezone);
    if (!svc.schedule.days.includes(dayOfDate)) continue;

    const startMin = parseWallHHMM(svc.schedule.start);
    const endMin = parseWallHHMM(svc.schedule.end);
    // A booking must fit entirely inside the service window.
    const lastStart = endMin - svc.turnMinutes;
    if (lastStart < startMin) continue;

    for (let m = startMin; m <= lastStart; m += step) {
      const wallStart = formatWallHHMM(m);
      const startAt = zonedWallToUtc(input.date, wallStart, input.timezone);
      const endAt = new Date(startAt.getTime() + svc.turnMinutes * 60_000);

      const free = input.tables.filter(
        (t) => !isTableOccupied(t.id, startAt, endAt, input.occupied),
      );

      const options = buildTableOptions(free, input.partySize);
      if (options.length === 0) continue;

      slots.push({
        serviceId: svc.id,
        serviceName: svc.name,
        startAt,
        endAt,
        wallStart,
        options,
      });
    }
  }

  return slots;
}

// A table is occupied for [startAt, endAt) iff any existing occupancy
// on that table overlaps. Half-open intervals: booking ending exactly
// at the new start is fine.
function isTableOccupied(
  tableId: string,
  startAt: Date,
  endAt: Date,
  occupied: Occupancy[],
): boolean {
  const s = startAt.getTime();
  const e = endAt.getTime();
  for (const o of occupied) {
    if (o.tableId !== tableId) continue;
    if (o.endAt.getTime() <= s) continue;
    if (o.startAt.getTime() >= e) continue;
    return true;
  }
  return false;
}

// Pick table options for a party. Prefer smallest-sufficient single
// tables; fall back to same-area pairs if no single fits.
function buildTableOptions(free: TableSpec[], partySize: number): TableOption[] {
  const singles = free
    .filter((t) => partySize >= t.minCover && partySize <= t.maxCover)
    .sort((a, b) => a.maxCover - b.maxCover)
    .map<TableOption>((t) => ({
      tableIds: [t.id],
      totalMaxCover: t.maxCover,
      totalMinCover: t.minCover,
      areaId: t.areaId,
    }));

  if (singles.length > 0) return singles;

  // Combine pairs within the same area. O(n^2) — fine for realistic
  // venues (≤ ~50 tables). Limits to pairs; triples are a follow-up.
  const byArea = new Map<string, TableSpec[]>();
  for (const t of free) {
    const list = byArea.get(t.areaId) ?? [];
    list.push(t);
    byArea.set(t.areaId, list);
  }

  const pairs: TableOption[] = [];
  for (const group of byArea.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const maxSum = a.maxCover + b.maxCover;
        // Sum caps the party. Floor is max of the individual mins —
        // neither table can be left below its own minimum split.
        const minFloor = Math.max(a.minCover, b.minCover);
        if (partySize >= minFloor && partySize <= maxSum) {
          pairs.push({
            tableIds: [a.id, b.id],
            totalMaxCover: maxSum,
            totalMinCover: minFloor,
            areaId: a.areaId,
          });
        }
      }
    }
  }
  return pairs.sort((x, y) => x.totalMaxCover - y.totalMaxCover);
}
