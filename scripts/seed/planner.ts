// Shared booking planner — the pure, DB-free half of the seeders. Extracted
// from scripts/seed-mock-data.ts so both it and scripts/seed-staging.ts plan
// bookings the same way rather than duplicating the logic. Nothing here knows
// about a specific venue id: it is parameterised entirely by its input.
//
// The planner fills the previous N venue-local days and the next N days to a
// target fraction of each scheduled service's room capacity, producing a
// realistic status mix (finished / no_show in the past, confirmed / requested
// in the future, plus a few cancelled), with deposits on a subset — the same
// shapes the dashboard's Service Summary and reports read.

import { dayKeyInZone, zonedWallToUtc, type DayKey } from "@/lib/bookings/time";

// --- Config ------------------------------------------------------------------

export type PlannerConfig = {
  pastDays: number;
  futureDays: number;
  pastFill: number;
  futureFill: number;
  depositProbability: number;
  guestPoolSize: number;
};

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  pastDays: 7,
  futureDays: 7,
  pastFill: 0.6,
  futureFill: 0.5,
  depositProbability: 0.4,
  guestPoolSize: 60,
};

// Valid bookings.source values (bookings_source_check admits
// host/widget/rwg/api/walk-in/event). Weighted toward the online widget for a
// believable channel mix; 'event' is intentionally excluded — event bookings
// carry a null service/area and are a different shape.
export const SOURCES = [
  "widget",
  "widget",
  "widget",
  "host",
  "host",
  "rwg",
  "walk-in",
  "api",
] as const;

// --- Types -------------------------------------------------------------------

export type BookingStatus =
  | "requested"
  | "confirmed"
  | "seated"
  | "finished"
  | "cancelled"
  | "no_show";

export type ServiceRow = {
  id: string;
  name: string;
  schedule: { days: DayKey[]; start: string; end: string };
  turnMinutes: number;
};

export type TableRow = { id: string; areaId: string; minCover: number; maxCover: number };

export type PlannedBooking = {
  serviceId: string;
  serviceName: string;
  areaId: string;
  tableId: string | null; // null for cancelled (frees the table)
  partySize: number;
  startAt: Date;
  endAt: Date;
  status: BookingStatus;
  source: string;
  guestIndex: number;
  createdAt: Date;
  cancelledAt: Date | null;
  withDeposit: boolean;
  withNoShowCapture: boolean;
  dateYMD: string;
};

export type PlanInput = {
  todayYMD: string;
  now: Date;
  timezone: string;
  capacity: number;
  servicesList: ServiceRow[];
  tables: TableRow[];
  existingOccupancy: Array<{ tableId: string; startMs: number; endMs: number }>;
  config?: Partial<PlannerConfig>;
};

// --- Small RNG helpers (Math.random is fine for mock data) -------------------

export function pickInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
export function pickOne<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
export function chance(p: number): boolean {
  return Math.random() < p;
}
export function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return h * 60 + m;
}
export function hhmm(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
// Calendar-date arithmetic on a YYYY-MM-DD string (zone-agnostic — these are
// local calendar days, not instants).
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function partySizeFor(remaining: number): number {
  const draw = pickOne([2, 2, 2, 3, 3, 4, 4]);
  if (remaining <= 2) return 2;
  return Math.min(draw, Math.max(2, remaining));
}

function pickStatus(isPast: boolean): BookingStatus {
  if (isPast) return chance(0.15) ? "no_show" : "finished";
  return chance(0.15) ? "requested" : "confirmed";
}

// --- Planner -----------------------------------------------------------------

export function planBookings(input: PlanInput): PlannedBooking[] {
  const cfg = { ...DEFAULT_PLANNER_CONFIG, ...input.config };
  const { todayYMD, now, timezone, capacity, servicesList, tables } = input;
  const plans: PlannedBooking[] = [];

  // Per-table occupied intervals across the whole window — the gist EXCLUDE
  // constraint forbids overlapping [start,end) on the same table. Seeded with
  // any pre-existing (non-seed) bookings so we never collide with them.
  const occupancy = new Map<string, Array<[number, number]>>();
  for (const e of input.existingOccupancy) {
    const intervals = occupancy.get(e.tableId) ?? [];
    intervals.push([e.startMs, e.endMs]);
    occupancy.set(e.tableId, intervals);
  }

  function findFreeTable(start: Date, end: Date): TableRow | null {
    const s = start.getTime();
    const e = end.getTime();
    for (const t of [...tables].sort(() => Math.random() - 0.5)) {
      const intervals = occupancy.get(t.id) ?? [];
      if (intervals.some(([is, ie]) => s < ie && e > is)) continue;
      intervals.push([s, e]);
      occupancy.set(t.id, intervals);
      return t;
    }
    return null;
  }

  const offsets: Array<{ offset: number; isPast: boolean; fill: number }> = [];
  for (let d = cfg.pastDays; d >= 1; d--)
    offsets.push({ offset: -d, isPast: true, fill: cfg.pastFill });
  for (let d = 1; d <= cfg.futureDays; d++)
    offsets.push({ offset: d, isPast: false, fill: cfg.futureFill });

  for (const { offset, isPast, fill } of offsets) {
    const dateYMD = addDays(todayYMD, offset);
    const weekday = dayKeyInZone(zonedWallToUtc(dateYMD, "12:00", timezone), timezone);
    const todaysServices = servicesList.filter((s) => s.schedule.days.includes(weekday));

    for (const svc of todaysServices) {
      const target = Math.round(fill * capacity);
      const openMin = parseHHMM(svc.schedule.start);
      const closeMin = parseHHMM(svc.schedule.end);
      const latestStart = closeMin - svc.turnMinutes;
      if (latestStart <= openMin) continue;

      let covers = 0;
      let guard = 0;
      while (covers < target && guard < 600) {
        guard++;
        const startMin = openMin + pickInt(0, Math.floor((latestStart - openMin) / 15)) * 15;
        const startAt = zonedWallToUtc(dateYMD, hhmm(startMin), timezone);
        const endAt = new Date(startAt.getTime() + svc.turnMinutes * 60_000);
        const table = findFreeTable(startAt, endAt);
        if (!table) continue;

        const party = partySizeFor(target - covers);
        const status = pickStatus(isPast);
        const leadDays = pickInt(1, 14);
        let createdAt = new Date(startAt.getTime() - leadDays * 86_400_000);
        if (createdAt > now) createdAt = new Date(now.getTime() - 3_600_000);
        const withDeposit = chance(cfg.depositProbability);

        plans.push({
          serviceId: svc.id,
          serviceName: svc.name,
          areaId: table.areaId,
          tableId: table.id,
          partySize: party,
          startAt,
          endAt,
          status,
          source: pickOne(SOURCES),
          guestIndex: pickInt(0, cfg.guestPoolSize - 1),
          createdAt,
          cancelledAt: null,
          withDeposit,
          withNoShowCapture: status === "no_show" && withDeposit && chance(0.5),
          dateYMD,
        });
        covers += party;
      }

      // A few cancelled bookings on top (excluded from utilisation; no table).
      const cancelCount = pickInt(1, 3);
      for (let i = 0; i < cancelCount; i++) {
        const startMin = openMin + pickInt(0, Math.floor((latestStart - openMin) / 15)) * 15;
        const startAt = zonedWallToUtc(dateYMD, hhmm(startMin), timezone);
        const endAt = new Date(startAt.getTime() + svc.turnMinutes * 60_000);
        const leadDays = pickInt(1, 14);
        let createdAt = new Date(startAt.getTime() - leadDays * 86_400_000);
        if (createdAt > now) createdAt = new Date(now.getTime() - 3_600_000);
        const cancelledAt = new Date(Math.min(now.getTime(), createdAt.getTime() + 7_200_000));
        plans.push({
          serviceId: svc.id,
          serviceName: svc.name,
          areaId: pickOne(tables).areaId,
          tableId: null,
          partySize: partySizeFor(4),
          startAt,
          endAt,
          status: "cancelled",
          source: pickOne(SOURCES),
          guestIndex: pickInt(0, cfg.guestPoolSize - 1),
          createdAt,
          cancelledAt,
          withDeposit: false,
          withNoShowCapture: false,
          dateYMD,
        });
      }
    }
  }

  return plans;
}
