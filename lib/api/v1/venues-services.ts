// Read queries for v1 venues + services endpoints.
//
// Both lists are unbounded but small in practice (typical venue
// counts are <50 per org; services <50 per venue), so no pagination
// today. If a customer ever blows past 200 we'll add cursor support
// — same pattern as bookings/guests. Returns are alphabetically
// ordered by name for stable client-side rendering.
//
// All columns are operator-controlled metadata; no PII to decrypt.

import "server-only";

import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { services, venues } from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

export type SerialisedVenue = {
  id: string;
  name: string;
  slug: string | null;
  venue_type: string;
  timezone: string;
  locale: string;
  created_at: string;
};

export async function listVenues(
  db: Db,
  args: { organisationId: string },
): Promise<{ data: SerialisedVenue[] }> {
  const rows = await db
    .select({
      id: venues.id,
      name: venues.name,
      slug: venues.slug,
      venueType: venues.venueType,
      timezone: venues.timezone,
      locale: venues.locale,
      createdAt: venues.createdAt,
    })
    .from(venues)
    .where(eq(venues.organisationId, args.organisationId))
    .orderBy(asc(venues.name))
    .limit(200);

  return {
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      venue_type: r.venueType,
      timezone: r.timezone,
      locale: r.locale,
      created_at: r.createdAt.toISOString(),
    })),
  };
}

export type SerialisedService = {
  id: string;
  venue_id: string;
  name: string;
  schedule: unknown;
  turn_minutes: number;
  created_at: string;
};

export async function listServices(
  db: Db,
  args: { organisationId: string; venueId?: string | undefined },
): Promise<{ data: SerialisedService[] }> {
  const conds = [eq(services.organisationId, args.organisationId)];
  if (args.venueId) conds.push(eq(services.venueId, args.venueId));

  const rows = await db
    .select({
      id: services.id,
      venueId: services.venueId,
      name: services.name,
      schedule: services.schedule,
      turnMinutes: services.turnMinutes,
      createdAt: services.createdAt,
    })
    .from(services)
    .where(and(...conds))
    .orderBy(asc(services.name))
    .limit(200);

  return {
    data: rows.map((r) => ({
      id: r.id,
      venue_id: r.venueId,
      name: r.name,
      schedule: r.schedule,
      turn_minutes: r.turnMinutes,
      created_at: r.createdAt.toISOString(),
    })),
  };
}
