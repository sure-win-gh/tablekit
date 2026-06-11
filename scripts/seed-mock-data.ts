#!/usr/bin/env tsx
// One-off mock-data seeder for a single venue.
//
// Fills the previous 7 venue-local days at ~60% and the next 7 days at
// ~50% of each scheduled service's room capacity (covers ÷ capacity, the
// same metric the dashboard Service Summary shows). Produces a realistic
// status mix (finished / no_show / cancelled in the past; confirmed /
// requested / cancelled in the future), with deposits on a subset.
//
// All rows are tagged for clean removal and idempotent re-runs:
//   - bookings.source       = 'mock-seed'
//   - guests.imported_from  = 'mock-seed'
//   - guest emails          = *@example.invalid
// The script deletes prior mock-seed rows for the venue before inserting.
//
// Usage:
//   pnpm tsx scripts/seed-mock-data.ts --dry-run   # plan only, no writes
//   pnpm tsx scripts/seed-mock-data.ts             # write
//   pnpm tsx scripts/seed-mock-data.ts --verify    # write + print utilisation

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";

import { dayKeyInZone, venueLocalDayRange, zonedWallToUtc, type DayKey } from "@/lib/bookings/time";
import {
  areas,
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
import { adminDb } from "@/lib/server/admin/db";

// --- Config ------------------------------------------------------------------

const VENUE_ID = "72a9434f-1287-4745-a1c3-08395f1a8ff2";
const PAST_DAYS = 7;
const FUTURE_DAYS = 7;
const PAST_FILL = 0.6;
const FUTURE_FILL = 0.5;
const DEPOSIT_AMOUNT_MINOR = 1000; // £10 flat, matches the venue's deposit rule
const DEPOSIT_PROBABILITY = 0.4;
const GUEST_POOL_SIZE = 60;

// Stable marker written to bookings.notes so seeded rows are identifiable
// for idempotent cleanup (bookings.source is CHECK-constrained to real
// channel values, so we can't tag there). Mock guests are found via the
// bookings that reference them.
const MARKER = "[mock-seed]";
// Valid bookings.source values (bookings_source_check). Weighted toward
// the online widget for a believable channel mix.
const SOURCES = ["widget", "widget", "widget", "host", "host", "rwg", "walk-in", "api"] as const;

const FIRST_NAMES = [
  "Alex",
  "Priya",
  "Jamal",
  "Niamh",
  "Tom",
  "Anya",
  "Olu",
  "Iris",
  "Marco",
  "Yara",
  "Hugo",
  "Effy",
  "Sam",
  "Mei",
  "Theo",
  "Grace",
  "Daniel",
  "Leila",
  "Owen",
  "Saffron",
  "Raj",
  "Bea",
  "Callum",
  "Nadia",
  "Felix",
];
const LAST_NAMES = [
  "Patel",
  "Okafor",
  "Carter",
  "Murphy",
  "Singh",
  "Williams",
  "Tanaka",
  "Hassan",
  "Romano",
  "Reid",
  "Adebayo",
  "Bennett",
  "Khan",
  "Walker",
  "Costa",
  "Fletcher",
  "Nguyen",
  "Doyle",
  "Schmidt",
  "Ali",
  "Brooks",
  "Lindqvist",
];

// --- Small RNG helpers (Math.random is fine for mock data) -------------------

function pickInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pickOne<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function chance(p: number): boolean {
  return Math.random() < p;
}
function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return h * 60 + m;
}
function hhmm(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
// Calendar-date arithmetic on a YYYY-MM-DD string (zone-agnostic — these
// are local calendar days, not instants).
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// --- Types -------------------------------------------------------------------

type BookingStatus = "requested" | "confirmed" | "seated" | "finished" | "cancelled" | "no_show";

type ServiceRow = {
  id: string;
  name: string;
  schedule: { days: DayKey[]; start: string; end: string };
  turnMinutes: number;
};
type TableRow = { id: string; areaId: string; minCover: number; maxCover: number };

type PlannedBooking = {
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

// --- Planner -----------------------------------------------------------------

function partySizeFor(remaining: number): number {
  // Weighted toward 2s and 4s; clamp so we don't overshoot the target by a lot.
  const draw = pickOne([2, 2, 2, 3, 3, 4, 4]);
  if (remaining <= 2) return 2;
  return Math.min(draw, Math.max(2, remaining));
}

function pickStatus(isPast: boolean): BookingStatus {
  if (isPast) return chance(0.15) ? "no_show" : "finished";
  return chance(0.15) ? "requested" : "confirmed";
}

function plan(input: {
  todayYMD: string;
  now: Date;
  timezone: string;
  capacity: number;
  servicesList: ServiceRow[];
  tables: TableRow[];
  existingOccupancy: Array<{ tableId: string; startMs: number; endMs: number }>;
}): PlannedBooking[] {
  const { todayYMD, now, timezone, capacity, servicesList, tables } = input;
  const plans: PlannedBooking[] = [];
  // Per-table occupied intervals across the whole window — the gist EXCLUDE
  // constraint forbids overlapping [start,end) on the same table. Seeded
  // with any pre-existing (non-mock) bookings so we never collide with them.
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
  for (let d = PAST_DAYS; d >= 1; d--) offsets.push({ offset: -d, isPast: true, fill: PAST_FILL });
  for (let d = 1; d <= FUTURE_DAYS; d++)
    offsets.push({ offset: d, isPast: false, fill: FUTURE_FILL });

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
        const withDeposit = chance(DEPOSIT_PROBABILITY);

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
          guestIndex: pickInt(0, GUEST_POOL_SIZE - 1),
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
          guestIndex: pickInt(0, GUEST_POOL_SIZE - 1),
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

// --- Executor ----------------------------------------------------------------

function mockIntentId(): string {
  return `pi_mock_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const verify = process.argv.includes("--verify");
  const db = adminDb();

  const [venue] = await db
    .select({ id: venues.id, organisationId: venues.organisationId, timezone: venues.timezone })
    .from(venues)
    .where(eq(venues.id, VENUE_ID));
  if (!venue) throw new Error(`venue ${VENUE_ID} not found`);
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
    .where(eq(services.venueId, VENUE_ID))) as ServiceRow[];

  const tables = await db
    .select({
      id: venueTables.id,
      areaId: venueTables.areaId,
      minCover: venueTables.minCover,
      maxCover: venueTables.maxCover,
    })
    .from(venueTables)
    .where(eq(venueTables.venueId, VENUE_ID));

  const [capRow] = await db
    .select({ total: sql<number>`coalesce(sum(${venueTables.maxCover}), 0)::int`.as("total") })
    .from(venueTables)
    .where(eq(venueTables.venueId, VENUE_ID));
  const [override] = await db
    .select({ capacity: serviceCapacityOverrides.capacity })
    .from(serviceCapacityOverrides)
    .innerJoin(services, eq(services.id, serviceCapacityOverrides.serviceId))
    .where(eq(services.venueId, VENUE_ID))
    .limit(1);
  const capacity = override?.capacity ?? capRow?.total ?? 0;

  const now = new Date();
  const todayYMD = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  // Pre-existing (non-mock) table reservations in the window — seed the
  // occupancy map so we never collide with them on the no-double-book
  // gist constraint. Mock-seed rows are excluded (they get deleted below).
  const windowStart = venueLocalDayRange(addDays(todayYMD, -PAST_DAYS), timezone).startUtc;
  const windowEnd = venueLocalDayRange(addDays(todayYMD, FUTURE_DAYS), timezone).endUtc;
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
          eq(bookingTables.venueId, VENUE_ID),
          gte(bookingTables.startAt, windowStart),
          lt(bookingTables.startAt, windowEnd),
          sql`${bookings.notes} is distinct from ${MARKER}`,
        ),
      )
  ).map((r) => ({ tableId: r.tableId, startMs: r.startAt.getTime(), endMs: r.endAt.getTime() }));

  const planned = plan({
    todayYMD,
    now,
    timezone,
    capacity,
    servicesList,
    tables,
    existingOccupancy,
  });

  // Summary by date+service.
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
  console.log(`Venue: The Square (${VENUE_ID})  tz=${timezone}  capacity=${capacity}`);
  console.log(`Planned ${planned.length} bookings across ${byDay.size} service-days:\n`);
  for (const key of [...byDay.keys()].sort()) {
    const a = byDay.get(key)!;
    const pct = capacity ? Math.round((a.covers / capacity) * 100) : 0;
    console.log(
      `  ${key.padEnd(24)}  ${String(a.covers).padStart(3)} covers / ${capacity}  = ${String(pct).padStart(3)}%  (${a.n} active, ${a.cancelled} cancelled)`,
    );
  }
  const deposits = planned.filter((p) => p.withDeposit).length;
  const noShowCaps = planned.filter((p) => p.withNoShowCapture).length;
  console.log(
    `\nTotals: ${planned.length} bookings, ${deposits} deposits, ${noShowCaps} no-show captures.`,
  );

  if (dryRun) {
    console.log("\n--dry-run: no writes performed.");
    return;
  }

  // Build a guest pool (deterministic-ish names, unique emails).
  const guestPool = Array.from({ length: GUEST_POOL_SIZE }, (_, i) => {
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length]!;
    const lastName = LAST_NAMES[i % LAST_NAMES.length]!;
    return {
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${pad(i + 1)}@example.invalid`,
      phone: `+447700${pad(900000 + i).slice(-6)}`,
    };
  });

  await db.transaction(async (tx) => {
    // Idempotent cleanup of prior mock-seed rows for this venue. Mock
    // guests are seed-only, so we find them via the bookings that
    // reference them, delete the bookings (cascades booking_tables +
    // payments), then delete those now-orphaned guests.
    const priorMockGuests = await tx
      .selectDistinct({ guestId: bookings.guestId })
      .from(bookings)
      .where(and(eq(bookings.venueId, VENUE_ID), eq(bookings.notes, MARKER)));
    const priorGuestIds = priorMockGuests.map((r) => r.guestId);

    await tx
      .delete(bookings)
      .where(and(eq(bookings.venueId, VENUE_ID), eq(bookings.notes, MARKER)));

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

    // Insert guest pool, capture ids.
    const guestIds: string[] = [];
    for (const g of guestPool) {
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
      guestIds.push(row!.id);
    }

    for (const p of planned) {
      const depositIntentId = p.withDeposit ? mockIntentId() : null;
      const [booking] = await tx
        .insert(bookings)
        .values({
          organisationId: orgId,
          venueId: VENUE_ID,
          serviceId: p.serviceId,
          areaId: p.areaId,
          guestId: guestIds[p.guestIndex]!,
          partySize: p.partySize,
          startAt: p.startAt,
          endAt: p.endAt,
          status: p.status,
          source: p.source,
          depositIntentId,
          notes: MARKER,
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
          organisationId: orgId,
          venueId: VENUE_ID,
          areaId: p.areaId,
          startAt: p.startAt,
          endAt: p.endAt,
        });
      }

      if (depositIntentId) {
        await tx.insert(payments).values({
          organisationId: orgId,
          bookingId,
          kind: "deposit",
          stripeIntentId: depositIntentId,
          amountMinor: DEPOSIT_AMOUNT_MINOR,
          currency: "GBP",
          status: "succeeded",
          createdAt: p.createdAt,
          updatedAt: p.createdAt,
        });
      }
      if (p.withNoShowCapture) {
        await tx.insert(payments).values({
          organisationId: orgId,
          bookingId,
          kind: "no_show_capture",
          stripeIntentId: mockIntentId(),
          amountMinor: DEPOSIT_AMOUNT_MINOR,
          currency: "GBP",
          status: "succeeded",
          createdAt: new Date(p.startAt.getTime() + 7_200_000),
          updatedAt: new Date(p.startAt.getTime() + 7_200_000),
        });
      }
    }
  });

  console.log(`\nWrote ${guestPool.length} guests + ${planned.length} bookings.`);

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
