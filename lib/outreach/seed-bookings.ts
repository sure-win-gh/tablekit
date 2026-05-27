// Sample-bookings seeder for outreach pre-populated accounts.
//
// Split into a pure `planSampleBookings()` (deterministic given a
// `random` seed, no I/O) and `executeSampleBookings()` that takes a
// plan and writes guests + bookings + booking_tables via adminDb().
// The split lets us unit-test the distribution logic (weekday spread,
// table assignment, party-size bounds) without spinning up the
// crypto + DEK provisioning the guest rows need.
//
// Volume: ~15 bookings across the next 7 days, weighted toward
// Fri/Sat dinner. Each guest gets a clearly-fake last name and a
// `@example.invalid` email so the operator can tell sample data from
// real on sight. Each booking's notes field carries the marker
// "Sample booking — delete to remove".
//
// Timezone simplification: we anchor service windows to the venue's
// notional local clock and store the resulting Date as UTC. For a UK
// venue in BST this means a service "starting at 12:00" lands as a
// 12:00 UTC booking — the diary view will then render that as 13:00
// BST. Operators editing seeded bookings will see this small offset;
// it's acceptable for a demo seed and a one-line fix the operator can
// make if they care.
//
// FIXME(outreach-seed-tz): once the venue tz field is plumbed end-to-
// end through seed-bookings, swap Date.UTC for a tz-aware constructor
// so summer bookings land at the right wall-clock time.

import "server-only";

import { eq } from "drizzle-orm";

import { bookings, bookingTables, guests, services, venueTables } from "@/lib/db/schema";
import { encryptPii, hashForLookup } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

// --- Inputs ------------------------------------------------------------------

type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const DAY_ORDER: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type ServiceInput = {
  id: string;
  schedule: { days: DayKey[]; start: string; end: string };
  turnMinutes: number;
};

export type TableInput = {
  id: string;
  areaId: string;
  minCover: number;
  maxCover: number;
};

export type GuestSeed = {
  firstName: string;
  lastName: string;
  email: string;
};

export type SampleBookingPlan = {
  serviceId: string;
  areaId: string;
  tableId: string;
  partySize: number;
  startAt: Date;
  endAt: Date;
  guest: GuestSeed;
};

// Small UK name pool — diverse enough for ~15 sample rows; deliberate
// non-overlap with celebrity / political names so screenshots don't
// look loaded. Fake last names are deliberately surname-like rather
// than the literal string "Sample" — the marker on `notes` carries
// the "this is sample data" signal.
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
];

// --- Planner -----------------------------------------------------------------

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return { hour: h, minute: m };
}

function dayKey(d: Date): DayKey {
  // JS getDay() is 0=Sunday..6=Saturday.
  const idx = (d.getUTCDay() + 6) % 7; // shift to 0=Mon..6=Sun
  return DAY_ORDER[idx]!;
}

// Bookings per day, weighted toward Fri/Sat. Sums to ~15 across 7 days.
const DAILY_QUOTA: Record<DayKey, number> = {
  mon: 1,
  tue: 1,
  wed: 2,
  thu: 2,
  fri: 3,
  sat: 4,
  sun: 2,
};

function pickInt(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function pickOne<T>(random: () => number, arr: T[]): T {
  return arr[Math.floor(random() * arr.length)]!;
}

export function planSampleBookings(input: {
  services: ServiceInput[];
  tables: TableInput[];
  now: Date;
  random?: () => number;
}): SampleBookingPlan[] {
  const random = input.random ?? Math.random;
  if (input.services.length === 0 || input.tables.length === 0) return [];

  const plans: SampleBookingPlan[] = [];
  // Track (tableId, dayOffset) → array of [startMs, endMs] to avoid
  // double-booking a table at the same time on the same day.
  const occupancy = new Map<string, Array<[number, number]>>();

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dayDate = new Date(
      Date.UTC(
        input.now.getUTCFullYear(),
        input.now.getUTCMonth(),
        input.now.getUTCDate() + dayOffset,
      ),
    );
    const dk = dayKey(dayDate);
    const services = input.services.filter((s) => s.schedule.days.includes(dk));
    if (services.length === 0) continue;

    const quota = DAILY_QUOTA[dk];
    let attempts = 0;
    let placed = 0;
    while (placed < quota && attempts < quota * 4) {
      attempts++;
      const service = pickOne(random, services);
      const open = parseHHMM(service.schedule.start);
      const close = parseHHMM(service.schedule.end);
      const openMin = open.hour * 60 + open.minute;
      const closeMin = close.hour * 60 + close.minute;
      const latestStartMin = closeMin - service.turnMinutes;
      if (latestStartMin <= openMin) continue;

      // Snap start to 15-minute grid for natural-looking slots.
      const startMin = openMin + pickInt(random, 0, Math.floor((latestStartMin - openMin) / 15)) * 15;
      const start = new Date(
        Date.UTC(
          dayDate.getUTCFullYear(),
          dayDate.getUTCMonth(),
          dayDate.getUTCDate(),
          Math.floor(startMin / 60),
          startMin % 60,
        ),
      );
      const end = new Date(start.getTime() + service.turnMinutes * 60 * 1000);

      const table = pickOne(random, input.tables);
      const occKey = `${table.id}:${dayOffset}`;
      const existing = occupancy.get(occKey) ?? [];
      const conflict = existing.some(
        ([s, e]) => start.getTime() < e && end.getTime() > s,
      );
      if (conflict) continue;
      existing.push([start.getTime(), end.getTime()]);
      occupancy.set(occKey, existing);

      const minParty = Math.max(2, table.minCover);
      const maxParty = Math.min(6, table.maxCover);
      if (maxParty < minParty) continue; // Skip narrow-capacity tables rather than clamp.
      const partySize = pickInt(random, minParty, maxParty);

      const firstName = pickOne(random, FIRST_NAMES);
      const lastName = pickOne(random, LAST_NAMES);
      const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${pad(
        plans.length + 1,
      )}@example.invalid`;

      plans.push({
        serviceId: service.id,
        areaId: table.areaId,
        tableId: table.id,
        partySize,
        startAt: start,
        endAt: end,
        guest: { firstName, lastName, email },
      });
      placed++;
    }
  }

  return plans;
}

// --- Executor ----------------------------------------------------------------

const SAMPLE_NOTE = "Sample booking — delete to remove";

// Inserts the plan inside its own transaction. Deliberately not
// nested under create-claimable's outer txn — see the failure-isolation
// note in create-claimable.ts.
export async function executeSampleBookings(input: {
  organisationId: string;
  venueId: string;
  plans: SampleBookingPlan[];
}): Promise<void> {
  if (input.plans.length === 0) return;
  const db = adminDb();

  await db.transaction(async (tx) => {
    for (const p of input.plans) {
      const emailHash = hashForLookup(p.guest.email, "email");
      const lastNameCipher = await encryptPii(input.organisationId, p.guest.lastName);
      const emailCipher = await encryptPii(input.organisationId, p.guest.email);

      const [guest] = await tx
        .insert(guests)
        .values({
          organisationId: input.organisationId,
          firstName: p.guest.firstName,
          lastNameCipher,
          emailCipher,
          emailHash,
        })
        .returning({ id: guests.id });
      if (!guest) throw new Error("executeSampleBookings: guest insert returned no row");

      const [booking] = await tx
        .insert(bookings)
        .values({
          organisationId: input.organisationId,
          venueId: input.venueId,
          serviceId: p.serviceId,
          areaId: p.areaId,
          guestId: guest.id,
          partySize: p.partySize,
          startAt: p.startAt,
          endAt: p.endAt,
          status: "confirmed",
          source: "outreach-seed",
          notes: SAMPLE_NOTE,
        })
        .returning({ id: bookings.id });
      if (!booking) throw new Error("executeSampleBookings: booking insert returned no row");

      await tx.insert(bookingTables).values({
        bookingId: booking.id,
        tableId: p.tableId,
        organisationId: input.organisationId,
        venueId: input.venueId,
        areaId: p.areaId,
        startAt: p.startAt,
        endAt: p.endAt,
      });
    }
  });
}

// Convenience for create-claimable: planner + executor in one call.
// Read seeded service/table rows fresh out of the DB so IDs match.
export async function seedSampleBookings(input: {
  organisationId: string;
  venueId: string;
  now?: Date;
}): Promise<void> {
  const db = adminDb();
  const now = input.now ?? new Date();

  const seededServices = await db
    .select({
      id: services.id,
      schedule: services.schedule,
      turnMinutes: services.turnMinutes,
    })
    .from(services)
    .where(eq(services.organisationId, input.organisationId));

  const seededTables = await db
    .select({
      id: venueTables.id,
      areaId: venueTables.areaId,
      minCover: venueTables.minCover,
      maxCover: venueTables.maxCover,
    })
    .from(venueTables)
    .where(eq(venueTables.organisationId, input.organisationId));

  const plans = planSampleBookings({
    services: seededServices.map((s) => ({
      id: s.id,
      schedule: s.schedule as ServiceInput["schedule"],
      turnMinutes: s.turnMinutes,
    })),
    tables: seededTables,
    now,
  });

  await executeSampleBookings({
    organisationId: input.organisationId,
    venueId: input.venueId,
    plans,
  });
}
