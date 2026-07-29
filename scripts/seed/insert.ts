// Shared insert/cleanup half of the seeders. Extracted from
// scripts/seed-mock-data.ts so both it and scripts/seed-staging.ts write
// bookings identically. Parameterised by venue and by a cleanup marker — no
// hard-coded venue id, no hard-coded tag — so a caller controls exactly which
// rows it owns and can re-run idempotently.
//
// Idempotency contract: every row this module writes is tagged (bookings via
// notes = marker; seed guests are reachable only through those bookings), so a
// re-run deletes the prior tagged rows for the venue and reinserts. Running
// twice yields the same shape.

import { randomUUID } from "node:crypto";

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";

import { venueLocalDayRange } from "@/lib/bookings/time";
import {
  bookings,
  bookingTables,
  guests,
  payments,
  serviceCapacityOverrides,
  services,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { encryptPii, hashForLookup } from "@/lib/security/crypto";
import * as schema from "@/lib/db/schema";

import {
  addDays,
  planBookings,
  type PlannedBooking,
  type PlannerConfig,
  type ServiceRow,
  type TableRow,
} from "./planner";
import { buildGuestPool, type SeedGuest } from "./idempotency";

type Db = NodePgDatabase<typeof schema>;

// Re-exported so callers can import the pure helpers from one place.
export { buildGuestPool, diffRowCounts, type SeedGuest } from "./idempotency";

function mockIntentId(): string {
  return `pi_seed_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export type SeedVenueOptions = {
  venueId: string;
  /** Cleanup marker written to bookings.notes, e.g. "[staging-seed]". */
  marker: string;
  depositAmountMinor?: number;
  /** Unique prefix for guest emails so venues don't collide on emailHash. */
  guestPrefix?: string;
  config?: Partial<PlannerConfig>;
};

export type SeedCounts = {
  guests: number;
  bookings: number;
  cancelled: number;
  deposits: number;
  noShowCaptures: number;
};

/** Delete prior seed rows for a venue (bookings by marker, then orphaned seed guests). */
async function cleanupSeedRows(tx: Db, venueId: string, marker: string): Promise<void> {
  const priorGuests = await tx
    .selectDistinct({ guestId: bookings.guestId })
    .from(bookings)
    .where(and(eq(bookings.venueId, venueId), eq(bookings.notes, marker)));
  const priorGuestIds = priorGuests.map((r) => r.guestId);

  await tx.delete(bookings).where(and(eq(bookings.venueId, venueId), eq(bookings.notes, marker)));

  if (priorGuestIds.length > 0) {
    await tx
      .delete(guests)
      .where(
        and(
          inArray(guests.id, priorGuestIds),
          sql`not exists (select 1 from bookings b where b.guest_id = ${guests.id})`,
        ),
      );
  }
}

/** Insert the guest pool for an org, returning their ids in pool order. */
async function insertGuestPool(tx: Db, orgId: string, pool: SeedGuest[]): Promise<string[]> {
  const ids: string[] = [];
  for (const g of pool) {
    const [row] = await tx
      .insert(guests)
      .values({
        organisationId: orgId,
        firstName: g.firstName,
        lastNameCipher: await encryptPii(orgId, g.lastName),
        emailCipher: await encryptPii(orgId, g.email),
        emailHash: hashForLookup(g.email, "email"),
        phoneCipher: await encryptPii(orgId, g.phone),
      })
      .returning({ id: guests.id });
    ids.push(row!.id);
  }
  return ids;
}

/** Insert one planned booking plus its table hold and any deposit / capture payments. */
async function insertPlannedBooking(
  tx: Db,
  opts: {
    orgId: string;
    venueId: string;
    guestId: string;
    marker: string;
    depositAmountMinor: number;
  },
  p: PlannedBooking,
): Promise<void> {
  const depositIntentId = p.withDeposit ? mockIntentId() : null;
  const [booking] = await tx
    .insert(bookings)
    .values({
      organisationId: opts.orgId,
      venueId: opts.venueId,
      serviceId: p.serviceId,
      areaId: p.areaId,
      guestId: opts.guestId,
      partySize: p.partySize,
      startAt: p.startAt,
      endAt: p.endAt,
      status: p.status,
      source: p.source,
      depositIntentId,
      notes: opts.marker,
      cancelledAt: p.cancelledAt,
      cancelledReason: p.status === "cancelled" ? "Guest cancelled" : null,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
    })
    .returning({ id: bookings.id });
  const bookingId = booking!.id;

  if (p.tableId) {
    await tx.insert(bookingTables).values({
      bookingId,
      tableId: p.tableId,
      organisationId: opts.orgId,
      venueId: opts.venueId,
      areaId: p.areaId,
      startAt: p.startAt,
      endAt: p.endAt,
    });
  }

  if (depositIntentId) {
    await tx.insert(payments).values({
      organisationId: opts.orgId,
      bookingId,
      kind: "deposit",
      stripeIntentId: depositIntentId,
      amountMinor: opts.depositAmountMinor,
      currency: "GBP",
      status: "succeeded",
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
    });
  }
  if (p.withNoShowCapture) {
    const at = new Date(p.startAt.getTime() + 7_200_000);
    await tx.insert(payments).values({
      organisationId: opts.orgId,
      bookingId,
      kind: "no_show_capture",
      stripeIntentId: mockIntentId(),
      amountMinor: opts.depositAmountMinor,
      currency: "GBP",
      status: "succeeded",
      createdAt: at,
      updatedAt: at,
    });
  }
}

export type VenuePlanInputs = {
  orgId: string;
  timezone: string;
  capacity: number;
  servicesList: ServiceRow[];
  tables: TableRow[];
  existingOccupancy: Array<{ tableId: string; startMs: number; endMs: number }>;
  todayYMD: string;
  now: Date;
};

/**
 * Load everything the planner needs for a venue: its org, timezone, services,
 * tables, capacity (override or summed max_cover), and any pre-existing
 * (non-`marker`) table holds in the window so the planner avoids the
 * no-double-book gist constraint. Shared by seedVenueBookings and by
 * seed-mock-data's --dry-run.
 */
export async function loadVenuePlanInputs(
  db: Db,
  venueId: string,
  marker: string,
  config: Partial<PlannerConfig> = {},
): Promise<VenuePlanInputs> {
  const pastDays = config.pastDays ?? 7;
  const futureDays = config.futureDays ?? 7;

  const [venue] = await db
    .select({ id: venues.id, organisationId: venues.organisationId, timezone: venues.timezone })
    .from(venues)
    .where(eq(venues.id, venueId));
  if (!venue) throw new Error(`loadVenuePlanInputs: venue ${venueId} not found`);
  const orgId = venue.organisationId;
  const timezone = venue.timezone;

  const servicesList = (await db
    .select({
      id: services.id,
      name: services.name,
      schedule: services.schedule,
      turnMinutes: services.turnMinutes,
    })
    .from(services)
    .where(eq(services.venueId, venueId))) as ServiceRow[];

  const tables: TableRow[] = await db
    .select({
      id: venueTables.id,
      areaId: venueTables.areaId,
      minCover: venueTables.minCover,
      maxCover: venueTables.maxCover,
    })
    .from(venueTables)
    .where(eq(venueTables.venueId, venueId));

  const [capRow] = await db
    .select({ total: sql<number>`coalesce(sum(${venueTables.maxCover}), 0)::int`.as("total") })
    .from(venueTables)
    .where(eq(venueTables.venueId, venueId));
  const [override] = await db
    .select({ capacity: serviceCapacityOverrides.capacity })
    .from(serviceCapacityOverrides)
    .innerJoin(services, eq(services.id, serviceCapacityOverrides.serviceId))
    .where(eq(services.venueId, venueId))
    .limit(1);
  const capacity = override?.capacity ?? capRow?.total ?? 0;

  const now = new Date();
  const todayYMD = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const windowStart = venueLocalDayRange(addDays(todayYMD, -pastDays), timezone).startUtc;
  const windowEnd = venueLocalDayRange(addDays(todayYMD, futureDays), timezone).endUtc;
  const existingOccupancy = (
    await db
      .select({
        tableId: bookingTables.tableId,
        startAt: bookingTables.startAt,
        endAt: bookingTables.endAt,
      })
      .from(bookingTables)
      .innerJoin(bookings, eq(bookings.id, bookingTables.bookingId))
      .where(
        and(
          eq(bookingTables.venueId, venueId),
          gte(bookingTables.startAt, windowStart),
          lt(bookingTables.startAt, windowEnd),
          sql`${bookings.notes} is distinct from ${marker}`,
        ),
      )
  ).map((r) => ({ tableId: r.tableId, startMs: r.startAt.getTime(), endMs: r.endAt.getTime() }));

  return { orgId, timezone, capacity, servicesList, tables, existingOccupancy, todayYMD, now };
}

/**
 * Seed a venue's bookings to the planner's utilisation shapes, idempotently.
 * Cleans up prior marker rows and reinserts in one tx.
 */
export async function seedVenueBookings(db: Db, opts: SeedVenueOptions): Promise<SeedCounts> {
  const depositAmountMinor = opts.depositAmountMinor ?? 1000;
  const config = opts.config ?? {};
  const guestPoolSize = config.guestPoolSize ?? 60;

  const inputs = await loadVenuePlanInputs(db, opts.venueId, opts.marker, config);
  const orgId = inputs.orgId;

  const planned = planBookings({
    // Deterministic per venue+day so a same-day reseed reproduces the plan.
    seed: `${opts.venueId}:${inputs.todayYMD}`,
    todayYMD: inputs.todayYMD,
    now: inputs.now,
    timezone: inputs.timezone,
    capacity: inputs.capacity,
    servicesList: inputs.servicesList,
    tables: inputs.tables,
    existingOccupancy: inputs.existingOccupancy,
    config,
  });

  const pool = buildGuestPool(guestPoolSize, opts.guestPrefix);

  await db.transaction(async (tx) => {
    await cleanupSeedRows(tx, opts.venueId, opts.marker);
    const guestIds = await insertGuestPool(tx, orgId, pool);
    for (const p of planned) {
      await insertPlannedBooking(
        tx,
        {
          orgId,
          venueId: opts.venueId,
          guestId: guestIds[p.guestIndex]!,
          marker: opts.marker,
          depositAmountMinor,
        },
        p,
      );
    }
  });

  return {
    guests: pool.length,
    bookings: planned.length,
    cancelled: planned.filter((p) => p.status === "cancelled").length,
    deposits: planned.filter((p) => p.withDeposit).length,
    noShowCaptures: planned.filter((p) => p.withNoShowCapture).length,
  };
}
