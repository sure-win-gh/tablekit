// Integration tests for admin-dashboard metric queries.
//
// Seeds two orgs with overlapping data. Asserts:
//   1. signups / bookings / messages aggregate ACROSS both orgs (the
//      whole point of the admin surface — cross-org by design).
//   2. The metric functions accept an adminDb() handle and don't
//      apply per-org RLS scoping themselves.
//
// Distinct from rls-reports.test.ts which proves the operator
// surface ISOLATES orgs. Here we prove the platform-staff surface
// SUMS across them.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getBookingCounts } from "@/lib/server/admin/dashboard/metrics/bookings";
import { getMessageVolume7d } from "@/lib/server/admin/dashboard/metrics/messages";
import { getSignupCounts } from "@/lib/server/admin/dashboard/metrics/signups";

type Db = NodePgDatabase<typeof schema>;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

let orgAId: string;
let orgBId: string;
let venueAId: string;
let venueBId: string;
let guestAId: string;
let guestBId: string;
let bookingAId: string;
let bookingBId: string;

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `M-A ${run}`, slug: `m-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `M-B ${run}`, slug: `m-b-${run}` })
    .returning({ id: schema.organisations.id });
  orgAId = orgA!.id;
  orgBId = orgB!.id;

  const [venueA] = await db
    .insert(schema.venues)
    .values({ organisationId: orgAId, name: "VA", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({ organisationId: orgBId, name: "VB", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  venueAId = venueA!.id;
  venueBId = venueB!.id;

  const [serviceA] = await db
    .insert(schema.services)
    .values({
      organisationId: orgAId,
      venueId: venueAId,
      name: "L",
      schedule: { days: ["mon"], start: "09:00", end: "22:00" },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });
  const [serviceB] = await db
    .insert(schema.services)
    .values({
      organisationId: orgBId,
      venueId: venueBId,
      name: "L",
      schedule: { days: ["mon"], start: "09:00", end: "22:00" },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });

  const [areaA] = await db
    .insert(schema.areas)
    .values({ organisationId: orgAId, venueId: venueAId, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [areaB] = await db
    .insert(schema.areas)
    .values({ organisationId: orgBId, venueId: venueBId, name: "Inside" })
    .returning({ id: schema.areas.id });

  const [guestA] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgAId,
      firstName: "A",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `m_a_${run}`,
    })
    .returning({ id: schema.guests.id });
  const [guestB] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgBId,
      firstName: "B",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `m_b_${run}`,
    })
    .returning({ id: schema.guests.id });
  guestAId = guestA!.id;
  guestBId = guestB!.id;

  const now = new Date();
  const start = new Date(now.getTime() + HOUR);
  const end = new Date(now.getTime() + 2 * HOUR);

  const [bA] = await db
    .insert(schema.bookings)
    .values({
      organisationId: orgAId,
      venueId: venueAId,
      serviceId: serviceA!.id,
      areaId: areaA!.id,
      guestId: guestAId,
      partySize: 2,
      startAt: start,
      endAt: end,
      status: "confirmed",
      source: "host",
    })
    .returning({ id: schema.bookings.id });
  const [bB] = await db
    .insert(schema.bookings)
    .values({
      organisationId: orgBId,
      venueId: venueBId,
      serviceId: serviceB!.id,
      areaId: areaB!.id,
      guestId: guestBId,
      partySize: 4,
      startAt: start,
      endAt: end,
      status: "confirmed",
      source: "widget",
    })
    .returning({ id: schema.bookings.id });
  bookingAId = bA!.id;
  bookingBId = bB!.id;

  await db.insert(schema.messages).values([
    {
      organisationId: orgAId,
      bookingId: bookingAId,
      channel: "email",
      template: "booking.confirmation",
      status: "delivered",
    },
    {
      organisationId: orgBId,
      bookingId: bookingBId,
      channel: "sms",
      template: "booking.reminder_2h",
      status: "sent",
    },
  ]);
});

afterAll(async () => {
  if (orgAId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  if (orgBId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await pool.end();
});

describe("admin metrics aggregate across organisations", () => {
  it("getSignupCounts sees both seeded orgs in last30d", async () => {
    const counts = await getSignupCounts(db);
    expect(counts.last30d).toBeGreaterThanOrEqual(2);
  });

  it("getBookingCounts sees both seeded bookings in last7d and source mix has host + widget", async () => {
    const counts = await getBookingCounts(db);
    expect(counts.last7d).toBeGreaterThanOrEqual(2);
    const sources = new Set(counts.sourceMix7d.map((r) => r.source));
    expect(sources.has("host")).toBe(true);
    expect(sources.has("widget")).toBe(true);
  });

  it("getMessageVolume7d sees both seeded messages across channels", async () => {
    const rows = await getMessageVolume7d(db);
    const emailDelivered = rows.find((r) => r.channel === "email" && r.status === "delivered");
    const smsSent = rows.find((r) => r.channel === "sms" && r.status === "sent");
    expect(emailDelivered?.count ?? 0).toBeGreaterThanOrEqual(1);
    expect(smsSent?.count ?? 0).toBeGreaterThanOrEqual(1);
  });
});
