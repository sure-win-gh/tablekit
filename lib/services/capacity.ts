// Capacity resolution for the Service Summary surface.
//
// A service's capacity defaults to the venue's whole-room capacity — the
// summed max_cover of every table (venueTables has no active flag, so all
// tables count). A service_capacity_overrides row replaces that for
// services that run a smaller room. Capacity is not per-service table
// assignment; we don't model that.

import "server-only";

import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { serviceCapacityOverrides, services, venueTables } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

// Pure: the override wins when present, else the summed table capacity.
export function resolveCapacity(roomCapacity: number, override: number | null | undefined): number {
  return override ?? roomCapacity;
}

// Whole-room capacity for a venue — sum of every table's max_cover.
export async function getRoomCapacity(db: Db, venueId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${venueTables.maxCover}), 0)::int`.as("total") })
    .from(venueTables)
    .where(eq(venueTables.venueId, venueId));
  return row?.total ?? 0;
}

// Map of serviceId → override capacity for the venue's services. Absent
// keys fall back to room capacity via resolveCapacity.
export async function getServiceCapacityOverrides(
  db: Db,
  venueId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      serviceId: serviceCapacityOverrides.serviceId,
      capacity: serviceCapacityOverrides.capacity,
    })
    .from(serviceCapacityOverrides)
    .innerJoin(services, eq(services.id, serviceCapacityOverrides.serviceId))
    .where(eq(services.venueId, venueId));
  return new Map(rows.map((r) => [r.serviceId, r.capacity]));
}
