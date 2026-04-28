// Integration test for getSignupsByDay / getBookingsByDay.
//
// Verifies the gap-filled day series: every day in the requested
// window must appear (even with zero count), and any seeded row in
// that window must contribute to its bucket.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getBookingsByDay } from "@/lib/server/admin/dashboard/metrics/bookings";
import { getSignupsByDay } from "@/lib/server/admin/dashboard/metrics/signups";

type Db = NodePgDatabase<typeof schema>;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
let orgId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Daily ${run}`, slug: `daily-${run}` })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;

  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: orgId, name: "V", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  const [service] = await db
    .insert(schema.services)
    .values({
      organisationId: orgId,
      venueId: venue!.id,
      name: "L",
      schedule: { days: ["mon"], start: "09:00", end: "22:00" },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: orgId, venueId: venue!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [guest] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgId,
      firstName: "G",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `daily_${run}`,
    })
    .returning({ id: schema.guests.id });

  await db.insert(schema.bookings).values({
    organisationId: orgId,
    venueId: venue!.id,
    serviceId: service!.id,
    areaId: area!.id,
    guestId: guest!.id,
    partySize: 2,
    startAt: new Date(Date.now() + 60 * 60 * 1000),
    endAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    status: "confirmed",
    source: "host",
  });
});

afterAll(async () => {
  if (orgId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("daily-bucket metrics", () => {
  it("getSignupsByDay returns 31 gap-filled buckets for 30-day window and counts the seeded org", async () => {
    const series = await getSignupsByDay(db, 30);
    // generate_series(start::date, end::date, '1 day') is inclusive
    // on both ends → 31 rows for a 30-day window.
    expect(series.length).toBe(31);
    const total = series.reduce((sum, b) => sum + b.n, 0);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(series.every((b) => Number.isInteger(b.n))).toBe(true);
  });

  it("getBookingsByDay returns gap-filled buckets and counts the seeded booking", async () => {
    const series = await getBookingsByDay(db, 30);
    expect(series.length).toBe(31);
    const total = series.reduce((sum, b) => sum + b.n, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it("days are formatted YYYY-MM-DD and ordered ascending", async () => {
    const series = await getSignupsByDay(db, 7);
    expect(series.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.day))).toBe(true);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.day > series[i - 1]!.day).toBe(true);
    }
  });
});
