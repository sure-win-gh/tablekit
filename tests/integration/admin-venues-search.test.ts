// Integration test for venues search + activity score + org-detail.
//
// Seeds two orgs: A (active — has bookings, messages, login audit
// events) and B (idle — no activity). Asserts:
//   1. searchVenues with empty query returns both orgs.
//   2. searchVenues with a name fragment matches the right org.
//   3. searchVenues with a venue-name fragment matches via the
//      EXISTS clause on venues.name.
//   4. Active org has activity > 0; idle org has activity = 0.
//   5. getOrgDetail returns the expected shape and counts.
//   6. getOrgDetail returns null for an unknown id.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getOrgDetail } from "@/lib/server/admin/dashboard/metrics/org-detail";
import { searchVenues } from "@/lib/server/admin/dashboard/metrics/venues-search";

type Db = NodePgDatabase<typeof schema>;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const A_NAME = `Active Cafe ${run}`;
const B_NAME = `Idle Bar ${run}`;
const A_VENUE = `Active Venue ${run}`;
const B_VENUE = `Idle Venue ${run}`;

let orgAId: string;
let orgBId: string;

beforeAll(async () => {
  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: A_NAME, slug: `active-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: B_NAME, slug: `idle-${run}` })
    .returning({ id: schema.organisations.id });
  orgAId = orgA!.id;
  orgBId = orgB!.id;

  const [venueA] = await db
    .insert(schema.venues)
    .values({ organisationId: orgAId, name: A_VENUE, venueType: "cafe" })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({ organisationId: orgBId, name: B_VENUE, venueType: "bar_pub" })
    .returning({ id: schema.venues.id });

  // Active org: a booking, a message, a successful login audit event.
  const [serviceA] = await db
    .insert(schema.services)
    .values({
      organisationId: orgAId,
      venueId: venueA!.id,
      name: "L",
      schedule: { days: ["mon"], start: "09:00", end: "22:00" },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });
  const [areaA] = await db
    .insert(schema.areas)
    .values({ organisationId: orgAId, venueId: venueA!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [guestA] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgAId,
      firstName: "T",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `vs_a_${run}`,
    })
    .returning({ id: schema.guests.id });

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const [bookingA] = await db
    .insert(schema.bookings)
    .values({
      organisationId: orgAId,
      venueId: venueA!.id,
      serviceId: serviceA!.id,
      areaId: areaA!.id,
      guestId: guestA!.id,
      partySize: 2,
      startAt: start,
      endAt: end,
      status: "confirmed",
      source: "host",
    })
    .returning({ id: schema.bookings.id });

  await db.insert(schema.messages).values({
    organisationId: orgAId,
    bookingId: bookingA!.id,
    channel: "email",
    template: "booking.confirmation",
    status: "delivered",
  });

  await db.insert(schema.auditLog).values({
    organisationId: orgAId,
    action: "login.success",
  });

  // Org B has venue B but no activity. Use venueB to avoid TS unused warning.
  expect(venueB).toBeDefined();
});

afterAll(async () => {
  if (orgAId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  if (orgBId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await pool.end();
});

describe("searchVenues", () => {
  it("empty query returns both seeded orgs", async () => {
    const rows = await searchVenues(db, "");
    const ids = new Set(rows.map((r) => r.orgId));
    expect(ids.has(orgAId)).toBe(true);
    expect(ids.has(orgBId)).toBe(true);
  });

  it("matches on org name", async () => {
    const rows = await searchVenues(db, `Active Cafe ${run}`);
    expect(rows.some((r) => r.orgId === orgAId)).toBe(true);
    expect(rows.every((r) => r.orgId !== orgBId)).toBe(true);
  });

  it("matches on venue name (EXISTS clause)", async () => {
    const rows = await searchVenues(db, A_VENUE);
    expect(rows.some((r) => r.orgId === orgAId)).toBe(true);
  });

  it("active org has activity > 0; idle org has activity = 0", async () => {
    const rows = await searchVenues(db, "");
    const a = rows.find((r) => r.orgId === orgAId);
    const b = rows.find((r) => r.orgId === orgBId);
    expect(a?.activityScore).toBeGreaterThan(0);
    expect(a?.bookings14d).toBeGreaterThanOrEqual(1);
    expect(a?.messages14d).toBeGreaterThanOrEqual(1);
    expect(a?.logins14d).toBeGreaterThanOrEqual(1);
    expect(b?.activityScore).toBe(0);
    expect(b?.bookings14d).toBe(0);
  });
});

describe("getOrgDetail", () => {
  it("returns the expected shape for the active org", async () => {
    const detail = await getOrgDetail(db, orgAId);
    expect(detail).not.toBeNull();
    expect(detail?.org.id).toBe(orgAId);
    expect(detail?.org.name).toBe(A_NAME);
    expect(detail?.venues).toHaveLength(1);
    expect(detail?.venues[0]?.name).toBe(A_VENUE);
    expect(detail?.counts30d.bookings).toBeGreaterThanOrEqual(1);
    expect(detail?.counts30d.messages).toBeGreaterThanOrEqual(1);
    expect(detail?.stripeConnect).toBeNull();
  });

  it("returns null for an unknown org id", async () => {
    const detail = await getOrgDetail(db, "00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });
});
