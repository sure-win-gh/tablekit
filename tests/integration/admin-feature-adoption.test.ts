// Integration smoke test for getFeatureAdoption.
//
// Seeds one org with two venues + one waitlist + one message + one
// review and asserts the feature-adoption snapshot picks them up.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getFeatureAdoption } from "@/lib/server/admin/dashboard/metrics/feature-adoption";

type Db = NodePgDatabase<typeof schema>;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
let orgId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Adopt ${run}`, slug: `adopt-${run}` })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;

  const [v1] = await db
    .insert(schema.venues)
    .values({ organisationId: orgId, name: "V1", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  await db
    .insert(schema.venues)
    .values({ organisationId: orgId, name: "V2", venueType: "bar_pub" });

  const [service] = await db
    .insert(schema.services)
    .values({
      organisationId: orgId,
      venueId: v1!.id,
      name: "L",
      schedule: { days: ["mon"], start: "09:00", end: "22:00" },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: orgId, venueId: v1!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [guest] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgId,
      firstName: "G",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `adopt_${run}`,
    })
    .returning({ id: schema.guests.id });
  const [booking] = await db
    .insert(schema.bookings)
    .values({
      organisationId: orgId,
      venueId: v1!.id,
      serviceId: service!.id,
      areaId: area!.id,
      guestId: guest!.id,
      partySize: 2,
      startAt: new Date(Date.now() + 60 * 60 * 1000),
      endAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      status: "confirmed",
      source: "host",
    })
    .returning({ id: schema.bookings.id });
  await db.insert(schema.messages).values({
    organisationId: orgId,
    bookingId: booking!.id,
    channel: "email",
    template: "booking.confirmation",
    status: "delivered",
  });
  await db.insert(schema.waitlists).values({
    organisationId: orgId,
    venueId: v1!.id,
    guestId: guest!.id,
    partySize: 2,
    status: "waiting",
  });
  await db.insert(schema.reviews).values({
    organisationId: orgId,
    venueId: v1!.id,
    bookingId: booking!.id,
    guestId: guest!.id,
    rating: 5,
    source: "internal",
  });
});

afterAll(async () => {
  if (orgId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("getFeatureAdoption", () => {
  it("counts orgs using each seeded feature, plus venue type mix", async () => {
    const data = await getFeatureAdoption(db);

    expect(data.totalOrgs).toBeGreaterThanOrEqual(1);
    const byKey = new Map(data.features.map((f) => [f.key, f.orgsWithFeature]));
    expect(byKey.get("multi_venue") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byKey.get("waitlist") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byKey.get("any_message") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byKey.get("reviews") ?? 0).toBeGreaterThanOrEqual(1);

    const types = new Set(data.venueTypeMix.map((r) => r.venueType));
    expect(types.has("cafe")).toBe(true);
    expect(types.has("bar_pub")).toBe(true);
  });
});
