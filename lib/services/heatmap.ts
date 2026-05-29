// Calendar heatmap data — one row per day of the month containing the
// selected date: booked covers (a single aggregate query) and the day's
// aggregate capacity (computed in TS from the services scheduled that
// weekday, so no second query). The client buckets utilisation into heat
// colours; this just supplies the numbers.

import "server-only";

import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { dayKeyInZone, zonedWallToUtc, type DayKey } from "@/lib/bookings/time";
import { bookings, services } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import { getRoomCapacity, getServiceCapacityOverrides, resolveCapacity } from "./capacity";
import { daysInMonth } from "./calendar";

type Db = NodePgDatabase<typeof schema>;
type Schedule = { days: DayKey[]; start: string; end: string };

export type DayUtilisation = {
  day: string; // YYYY-MM-DD venue-local
  bookedCovers: number;
  capacity: number;
  utilisation: number; // 0..n; 0 when capacity is 0
};

// `monthFirstYMD` is any date in the target month; only year/month matter.
export async function getHeatmap(
  db: Db,
  venueId: string,
  monthFirstYMD: string,
  timezone: string,
): Promise<DayUtilisation[]> {
  const [y = 1970, m = 1] = monthFirstYMD.split("-").map(Number);
  const total = daysInMonth(y, m);
  const firstYmd = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const startUtc = zonedWallToUtc(firstYmd, "00:00", timezone);
  const endUtc = zonedWallToUtc(nextMonth, "00:00", timezone);

  const [bookedRows, serviceRows] = await Promise.all([
    db
      .select({
        day: sql<string>`(${bookings.startAt} AT TIME ZONE ${timezone})::date::text`.as("day"),
        bookedCovers: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("bookedCovers"),
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.venueId, venueId),
          gte(bookings.startAt, startUtc),
          lt(bookings.startAt, endUtc),
          ne(bookings.status, "cancelled"),
        ),
      )
      .groupBy(sql`1`),
    db
      .select({ id: services.id, schedule: services.schedule })
      .from(services)
      .where(eq(services.venueId, venueId)),
  ]);

  const roomCapacity = await getRoomCapacity(db, venueId);
  const overrides = await getServiceCapacityOverrides(db, venueId);
  const bookedByDay = new Map(bookedRows.map((r) => [r.day, r.bookedCovers]));

  // Resolved capacity per service, computed once.
  const serviceCaps = serviceRows.map((s) => ({
    days: (s.schedule as Schedule).days,
    capacity: resolveCapacity(roomCapacity, overrides.get(s.id)),
  }));

  const out: DayUtilisation[] = [];
  for (let d = 1; d <= total; d++) {
    const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const weekday = dayKeyInZone(zonedWallToUtc(day, "12:00", timezone), timezone);
    // A day's capacity is the sum of capacities of services running that
    // weekday (seats × sittings) — empty when nothing is scheduled.
    const capacity = serviceCaps
      .filter((s) => s.days.includes(weekday))
      .reduce((sum, s) => sum + s.capacity, 0);
    const bookedCovers = bookedByDay.get(day) ?? 0;
    out.push({
      day,
      bookedCovers,
      capacity,
      utilisation: capacity === 0 ? 0 : bookedCovers / capacity,
    });
  }
  return out;
}
