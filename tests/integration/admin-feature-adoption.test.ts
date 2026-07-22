// Integration smoke test for getFeatureAdoption.
//
// Seeds one org with two venues + one waitlist + one message + one
// review + one enquiry + one sent campaign + one POS connection + one
// import job + one API key and asserts the feature-adoption snapshot
// picks them all up.

import { createHash } from "node:crypto";

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
  await db.insert(schema.enquiries).values({
    organisationId: orgId,
    venueId: v1!.id,
    fromEmailHash: `enq_${run}`,
    fromEmailCipher: "c",
    subjectCipher: "c",
    bodyCipher: "c",
  });
  await db.insert(schema.campaigns).values({
    organisationId: orgId,
    venueId: v1!.id,
    name: "Summer push",
    channel: "email",
    status: "sent",
    body: "b",
    sentAt: new Date(),
  });
  await db.insert(schema.posConnections).values({
    organisationId: orgId,
    venueId: v1!.id,
    provider: "generic",
  });
  await db.insert(schema.importJobs).values({
    organisationId: orgId,
    source: "generic-csv",
    filename: "guests.csv",
  });
  await db.insert(schema.apiKeys).values({
    organisationId: orgId,
    // Shape constraints from 0029: prefix ~ '^sk_live_[A-Za-z0-9_-]{4}$',
    // hash ~ '^[0-9a-f]{64}$'.
    prefix: `sk_live_${run.slice(-4)}`,
    hash: createHash("sha256").update(run).digest("hex"),
    label: "test key",
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
    expect(byKey.get("enquiries") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byKey.get("campaigns") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byKey.get("pos") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byKey.get("imports") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byKey.get("api_keys") ?? 0).toBeGreaterThanOrEqual(1);

    const types = new Set(data.venueTypeMix.map((r) => r.venueType));
    expect(types.has("cafe")).toBe(true);
    expect(types.has("bar_pub")).toBe(true);
  });
});
