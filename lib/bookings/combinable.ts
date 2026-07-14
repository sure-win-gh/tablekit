// Loads a venue's operator-set table-join edges + the maxTables cap for
// the availability engine. Shared by every findSlots caller (public
// availability, month calendar, booking creation, walk-in, service
// summary) so the query + settings parse live in one place.
//
// Takes a db handle so it works under both adminDb() (public/server paths,
// RLS bypassed) and withUser() (RLS-scoped dashboard reads). See
// docs/specs/table-combining.md.

import "server-only";

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/lib/db/schema";
import { tableCombinations, venues } from "@/lib/db/schema";
import { parseTableCombining } from "@/lib/venues/table-combining";

import type { CombinableEdge } from "./availability";

export type VenueCombining = {
  combinable: CombinableEdge[];
  maxCombineTables: number;
};

export async function loadVenueCombining(
  db: NodePgDatabase<typeof schema>,
  venueId: string,
): Promise<VenueCombining> {
  const [edges, venueRows] = await Promise.all([
    db
      .select({ aId: tableCombinations.tableAId, bId: tableCombinations.tableBId })
      .from(tableCombinations)
      .where(eq(tableCombinations.venueId, venueId)),
    db.select({ settings: venues.settings }).from(venues).where(eq(venues.id, venueId)).limit(1),
  ]);

  return {
    combinable: edges,
    maxCombineTables: parseTableCombining(venueRows[0]?.settings).maxTables,
  };
}
