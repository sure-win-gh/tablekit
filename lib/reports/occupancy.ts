// Occupancy report — covers realised per service versus the seats that
// were actually on sale, so an operator can see where the room goes
// unsold ("dinner runs at 78%, Tuesday lunch at 22%").
//
// Capacity per session reuses the Service Summary machinery: the
// service's capacity override when present, else the whole-room summed
// max_cover. Sessions in range are counted from the service's schedule
// (pure calendar math on venue-local dates — the range strings are
// already venue-local, so no timezone conversion is needed here).

import "server-only";

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { DayKey } from "@/lib/bookings/time";
import { bookings, services } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import {
  getRoomCapacity,
  getServiceCapacityOverrides,
  resolveCapacity,
} from "@/lib/services/capacity";

import type { Bounds, OccupancyRow } from "./types";

type Db = NodePgDatabase<typeof schema>;
type Schedule = { days: DayKey[]; start: string; end: string };

const DAY_KEYS: readonly DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Pure: how many times each weekday occurs between two inclusive
// venue-local YYYY-MM-DD dates. UTC date arithmetic is safe because the
// inputs are calendar labels, not instants. Returns all-zero counts for
// an inverted range (parseFilter rejects those upstream anyway).
export function countWeekdayOccurrences(fromDate: string, toDate: string): Record<DayKey, number> {
  const counts: Record<DayKey, number> = {
    sun: 0,
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
    sat: 0,
  };
  const from = parseYmdUtc(fromDate);
  const to = parseYmdUtc(toDate);
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
    const key = DAY_KEYS[new Date(t).getUTCDay()];
    if (key) counts[key] += 1;
  }
  return counts;
}

function parseYmdUtc(ymd: string): Date {
  const [y = "1970", m = "01", d = "01"] = ymd.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

export async function getOccupancyReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
  range: { fromDate: string; toDate: string },
): Promise<OccupancyRow[]> {
  // Serial awaits — callers run reports inside a single-client
  // transaction (see the reports page), so no Promise.all here.
  const realisedRows = await db
    .select({
      serviceId: bookings.serviceId,
      coversRealised: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as(
        "coversRealised",
      ),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        inArray(bookings.status, ["confirmed", "seated", "finished"]),
      ),
    )
    .groupBy(bookings.serviceId);
  const serviceRows = await db
    .select({ id: services.id, name: services.name, schedule: services.schedule })
    .from(services)
    .where(eq(services.venueId, venueId));
  const roomCapacity = await getRoomCapacity(db, venueId);
  const overrides = await getServiceCapacityOverrides(db, venueId);

  const weekdayCounts = countWeekdayOccurrences(range.fromDate, range.toDate);
  const realisedByService = new Map(realisedRows.map((r) => [r.serviceId, r.coversRealised]));

  return serviceRows
    .map((s) => {
      // Defensive: a malformed schedule row (missing `days`) must not take
      // down the whole reports page — treat it as zero sessions.
      const days = (s.schedule as Schedule).days ?? [];
      const sessionsInRange = days.reduce((sum, d) => sum + (weekdayCounts[d] ?? 0), 0);
      const capacityPerSession = resolveCapacity(roomCapacity, overrides.get(s.id));
      const totalCapacity = sessionsInRange * capacityPerSession;
      const coversRealised = realisedByService.get(s.id) ?? 0;
      return {
        serviceId: s.id,
        serviceName: s.name,
        sessionsInRange,
        capacityPerSession,
        totalCapacity,
        coversRealised,
        utilisation: totalCapacity === 0 ? 0 : coversRealised / totalCapacity,
      };
    })
    .sort((a, b) => b.utilisation - a.utilisation || a.serviceName.localeCompare(b.serviceName));
}
