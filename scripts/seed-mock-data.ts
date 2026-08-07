#!/usr/bin/env tsx
// One-off mock-data seeder for a single venue.
//
// Fills the previous 7 venue-local days at ~60% and the next 7 days at ~50% of
// each scheduled service's room capacity (covers ÷ capacity, the metric the
// dashboard Service Summary shows), with a realistic status mix and deposits
// on a subset. The planning + insertion logic is shared with the staging
// seeder — see scripts/seed/planner.ts and scripts/seed/insert.ts.
//
// All rows are tagged `bookings.notes = '[mock-seed]'` (source is
// CHECK-constrained, so it can't be tagged there); seed guests are reachable
// only through those bookings. A re-run deletes prior mock-seed rows for the
// venue and reinserts — idempotent.
//
// Usage:
//   pnpm tsx scripts/seed-mock-data.ts --dry-run   # plan only, no writes
//   pnpm tsx scripts/seed-mock-data.ts             # write
//   pnpm tsx scripts/seed-mock-data.ts --verify    # write + print utilisation

import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

import { and, eq, gte, lt, ne, sql } from "drizzle-orm";

import { venueLocalDayRange } from "@/lib/bookings/time";
import { bookings, services } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { loadVenuePlanInputs, seedVenueBookings } from "./seed/insert";
import { addDays, planBookings } from "./seed/planner";

const VENUE_ID = "72a9434f-1287-4745-a1c3-08395f1a8ff2";
const MARKER = "[mock-seed]";
const PAST_DAYS = 7;
const FUTURE_DAYS = 7;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const verify = process.argv.includes("--verify");
  const db = adminDb();

  const inputs = await loadVenuePlanInputs(db, VENUE_ID, MARKER);
  const { capacity, timezone, todayYMD } = inputs;

  // Plan once for the summary (the write path re-plans internally; the shapes
  // match, only the random draw differs).
  const planned = planBookings({
    seed: `${VENUE_ID}:${todayYMD}`,
    todayYMD,
    now: inputs.now,
    timezone,
    capacity,
    servicesList: inputs.servicesList,
    tables: inputs.tables,
    existingOccupancy: inputs.existingOccupancy,
  });

  const byDay = new Map<string, { covers: number; n: number; cancelled: number }>();
  for (const p of planned) {
    const key = `${p.dateYMD}  ${p.serviceName}`;
    const agg = byDay.get(key) ?? { covers: 0, n: 0, cancelled: 0 };
    if (p.status === "cancelled") agg.cancelled++;
    else {
      agg.covers += p.partySize;
      agg.n++;
    }
    byDay.set(key, agg);
  }
  console.log(`Venue: ${VENUE_ID}  tz=${timezone}  capacity=${capacity}`);
  console.log(`Planned ~${planned.length} bookings across ${byDay.size} service-days.`);

  if (dryRun) {
    for (const key of [...byDay.keys()].sort()) {
      const a = byDay.get(key)!;
      const pct = capacity ? Math.round((a.covers / capacity) * 100) : 0;
      console.log(
        `  ${key.padEnd(24)}  ${String(a.covers).padStart(3)} / ${capacity} = ${String(pct).padStart(3)}%  (${a.n} active, ${a.cancelled} cancelled)`,
      );
    }
    console.log("\n--dry-run: no writes performed.");
    return;
  }

  const counts = await seedVenueBookings(db, {
    venueId: VENUE_ID,
    marker: MARKER,
    depositAmountMinor: 1000,
  });
  console.log(
    `\nWrote ${counts.guests} guests + ${counts.bookings} bookings ` +
      `(${counts.deposits} deposits, ${counts.noShowCaptures} no-show captures, ${counts.cancelled} cancelled).`,
  );

  if (verify) {
    console.log("\nVerification — covers ÷ capacity per venue-local day/service:");
    const offsets: number[] = [];
    for (let d = PAST_DAYS; d >= 1; d--) offsets.push(-d);
    for (let d = 1; d <= FUTURE_DAYS; d++) offsets.push(d);
    for (const off of offsets) {
      const dateYMD = addDays(todayYMD, off);
      const { startUtc, endUtc } = venueLocalDayRange(dateYMD, timezone);
      const rows = await db
        .select({
          name: services.name,
          covers: sql<number>`coalesce(sum(${bookings.partySize}),0)::int`.as("covers"),
          n: sql<number>`count(*)::int`.as("n"),
        })
        .from(bookings)
        .innerJoin(services, eq(services.id, bookings.serviceId))
        .where(
          and(
            eq(bookings.venueId, VENUE_ID),
            gte(bookings.startAt, startUtc),
            lt(bookings.startAt, endUtc),
            ne(bookings.status, "cancelled"),
          ),
        )
        .groupBy(services.name);
      for (const r of rows) {
        const pct = capacity ? Math.round((r.covers / capacity) * 100) : 0;
        console.log(
          `  ${dateYMD}  ${r.name.padEnd(12)} ${String(r.covers).padStart(3)}/${capacity} = ${pct}%  (${r.n})`,
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
