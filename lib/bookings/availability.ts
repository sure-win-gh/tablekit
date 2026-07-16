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

import { dayKeyInZone, formatWallHHMM, parseWallHHMM, zonedWallToUtc, type DayKey } from "./time";

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

// An operator-declared "these two tables can be pushed together" edge.
// Symmetric; order of aId/bId doesn't matter here.
export type CombinableEdge = { aId: string; bId: string };

export type AvailabilityInput = {
  timezone: string;
  date: string; // YYYY-MM-DD, venue-local
  partySize: number;
  services: ServiceSpec[];
  tables: TableSpec[];
  occupied: Occupancy[];
  slotStepMinutes?: number; // defaults to 15
  // Operator-set join edges (docs/specs/table-combining.md). When an area
  // has ≥1 edge, that area combines ONLY along declared edges (a connected
  // set of free tables). Areas with no edges fall back to legacy same-area
  // pairs. Omit/empty → behaviour identical to before this feature.
  combinable?: CombinableEdge[];
  // Most tables the engine will ever push together. Clamped to [2, 6].
  // Default 3. Legacy pair combining is size 2 and always available.
  maxCombineTables?: number;
  // Special-event closures blocking standard bookings on this venue
  // (docs/specs/special-events.md). Any candidate slot whose
  // [startAt, endAt) window overlaps a closure is dropped. Loaded by the
  // caller (loadClosures in lib/public/venue.ts) and injected so this
  // function stays pure. Omit/empty → behaviour identical to before the
  // feature. Half-open overlap, same rule as isTableOccupied.
  closures?: ClosureWindow[];
};

// A window during which standard bookings are blocked (a published,
// blocking special event). UTC instants; half-open [startAt, endAt).
export type ClosureWindow = { startAt: Date; endAt: Date };

// Precomputed, per-call combining context shared across every slot.
type CombineContext = {
  adj: Map<string, Set<string>>; // validated same-area adjacency
  configuredAreas: Set<string>; // areas with ≥1 declared edge → graph mode
  maxSize: number;
};

const MIN_COMBINE = 2;
const MAX_COMBINE = 6;
// Defensive bound: past this many free tables in one configured area we
// cap enumeration to pairs so a pathological config can't blow up the
// per-slot cost on the month view.
const DENSE_AREA_TABLE_LIMIT = 14;
// Never return more than this many options per slot — downstream only
// needs presence + membership, and the list is ranked best-first.
const MAX_OPTIONS_PER_SLOT = 24;

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

  const ctx = buildCombineContext(input);

  // Many slots share an identical set of free tables (e.g. every slot
  // before the day's first booking). buildTableOptions is pure in
  // (free-set, partySize) — both constant across this call except the
  // free-set — so memoise on the sorted free-table ids.
  const optionCache = new Map<string, TableOption[]>();

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

      // A special-event closure blocks the whole slot: if the booking
      // window overlaps any closure, this time isn't bookable as a
      // standard table at all (the date is sold as a ticketed event).
      if (overlapsClosure(startAt, endAt, input.closures)) continue;

      const free = input.tables.filter(
        (t) => !isTableOccupied(t.id, startAt, endAt, input.occupied),
      );

      const cacheKey = free
        .map((t) => t.id)
        .sort()
        .join(",");
      let options = optionCache.get(cacheKey);
      if (!options) {
        options = buildTableOptions(free, input.partySize, ctx);
        optionCache.set(cacheKey, options);
      }
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

// True iff [startAt, endAt) overlaps any closure window. Half-open, so a
// closure ending exactly at the slot start (or starting exactly at the
// slot end) does not block. Empty/undefined closures → never blocks, so
// the pre-feature behaviour is preserved byte-for-byte.
function overlapsClosure(
  startAt: Date,
  endAt: Date,
  closures: ClosureWindow[] | undefined,
): boolean {
  if (!closures || closures.length === 0) return false;
  const s = startAt.getTime();
  const e = endAt.getTime();
  for (const c of closures) {
    if (c.endAt.getTime() <= s) continue;
    if (c.startAt.getTime() >= e) continue;
    return true;
  }
  return false;
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

// Validate the operator's join edges once per findSlots call and index
// them as a same-area adjacency map. Edges whose endpoints are unknown or
// sit in different areas are dropped here — this is the load-time guard
// that stops a stale cross-area edge (e.g. a table moved between areas)
// from ever producing a combination the booking write path would reject.
function buildCombineContext(input: AvailabilityInput): CombineContext {
  const byId = new Map(input.tables.map((t) => [t.id, t]));
  const adj = new Map<string, Set<string>>();
  const configuredAreas = new Set<string>();

  for (const e of input.combinable ?? []) {
    const a = byId.get(e.aId);
    const b = byId.get(e.bId);
    if (!a || !b) continue; // unknown endpoint
    if (a.id === b.id) continue; // self-edge
    if (a.areaId !== b.areaId) continue; // cross-area (defensive)
    addEdge(adj, a.id, b.id);
    configuredAreas.add(a.areaId);
  }

  const raw = input.maxCombineTables ?? 3;
  const maxSize = Math.max(MIN_COMBINE, Math.min(MAX_COMBINE, Math.trunc(raw)));
  return { adj, configuredAreas, maxSize };
}

function addEdge(adj: Map<string, Set<string>>, a: string, b: string): void {
  (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
}

// Pick table options for a party. Prefer smallest-sufficient single
// tables; otherwise combine. A configured area (has join edges) only
// offers connected sets of free tables along those edges; an
// unconfigured area falls back to legacy same-area pairs. Combinations
// are ranked fewest-tables-then-least-waste and the list is capped.
function buildTableOptions(
  free: TableSpec[],
  partySize: number,
  ctx: CombineContext,
): TableOption[] {
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

  const byArea = new Map<string, TableSpec[]>();
  for (const t of free) {
    const list = byArea.get(t.areaId) ?? [];
    list.push(t);
    byArea.set(t.areaId, list);
  }

  const combos: TableOption[] = [];
  for (const [areaId, group] of byArea.entries()) {
    if (ctx.configuredAreas.has(areaId)) {
      // A configured area ONLY combines along its declared edges. If it's
      // pathologically dense we cap enumeration to edge-pairs (size 2) —
      // still edge-restricted, never any-same-area-pair, so the operator's
      // constraint is honoured even in the degraded path.
      const effMax = group.length > DENSE_AREA_TABLE_LIMIT ? 2 : ctx.maxSize;
      combos.push(...graphOptions(group, partySize, ctx.adj, effMax));
    } else {
      // Unconfigured area: legacy any-same-area pair. Uncapped, so this
      // path stays byte-identical to the pre-feature behaviour.
      combos.push(...legacyPairOptions(group, partySize));
    }
  }

  // Fewest tables first (a 2-top pair beats a 3-table snake for the same
  // party), then least waste (smallest total that still fits). With no
  // configured area every combo is a legacy pair (length 2), so this
  // reduces to the old sort-by-totalMaxCover and stays byte-identical.
  // Graph areas are already capped per-area in graphOptions; legacy pairs
  // are never truncated, keeping per-area behaviour independent.
  combos.sort((x, y) => x.tableIds.length - y.tableIds.length || x.totalMaxCover - y.totalMaxCover);
  return combos;
}

// Graph mode — every connected set of free tables (size 2..maxSize) in a
// configured area whose combined capacity can seat the party. Ranked and
// capped per-area so a dense graph can't return an unbounded option list.
function graphOptions(
  group: TableSpec[],
  partySize: number,
  adj: Map<string, Set<string>>,
  maxSize: number,
): TableOption[] {
  const specById = new Map(group.map((t) => [t.id, t]));
  const out: TableOption[] = [];
  for (const set of connectedSubsets(group, adj, maxSize)) {
    let totalMax = 0;
    let minFloor = 0;
    for (const id of set) {
      const t = specById.get(id)!;
      totalMax += t.maxCover;
      // Floor is the max of the individual mins — no table in the set can
      // be seated below its own minimum.
      if (t.minCover > minFloor) minFloor = t.minCover;
    }
    if (partySize >= minFloor && partySize <= totalMax) {
      out.push({
        tableIds: set,
        totalMaxCover: totalMax,
        totalMinCover: minFloor,
        areaId: group[0]!.areaId,
      });
    }
  }
  out.sort((x, y) => x.tableIds.length - y.tableIds.length || x.totalMaxCover - y.totalMaxCover);
  return out.length > MAX_OPTIONS_PER_SLOT ? out.slice(0, MAX_OPTIONS_PER_SLOT) : out;
}

// Enumerate connected subsets of size 2..maxSize over the adjacency map,
// restricted to the given area's tables. Deduped by sorted-id key so a
// set reached via different growth paths is emitted once.
function connectedSubsets(
  group: TableSpec[],
  adj: Map<string, Set<string>>,
  maxSize: number,
): string[][] {
  const inArea = new Set(group.map((t) => t.id));
  const seen = new Set<string>();
  const results: string[][] = [];
  let frontier: string[][] = group.map((t) => [t.id]); // size 1 seeds

  for (let size = 1; size < maxSize && frontier.length > 0; size++) {
    const next: string[][] = [];
    for (const subset of frontier) {
      const members = new Set(subset);
      // Candidate extensions = neighbours of any member, in-area, not
      // already in the set.
      const candidates = new Set<string>();
      for (const id of subset) {
        const ns = adj.get(id);
        if (!ns) continue;
        for (const n of ns) {
          if (inArea.has(n) && !members.has(n)) candidates.add(n);
        }
      }
      for (const n of candidates) {
        const combo = [...subset, n].sort();
        const key = combo.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(combo);
        results.push(combo);
      }
    }
    frontier = next;
  }

  return results;
}

// Legacy mode — any two tables in the same area combine, no adjacency.
// Preserved verbatim for areas the operator has never configured.
function legacyPairOptions(group: TableSpec[], partySize: number): TableOption[] {
  const pairs: TableOption[] = [];
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i]!;
      const b = group[j]!;
      const maxSum = a.maxCover + b.maxCover;
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
  return pairs;
}
