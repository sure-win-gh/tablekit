// Integration test for getOperationsSnapshot.
//
// Seeds: one org with a failed payment, one bounced + one delivered
// email message, a Stripe webhook event (handled), and an overdue
// open DSAR. Asserts every section returns plausible values.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getOperationsSnapshot } from "@/lib/server/admin/dashboard/metrics/operations";

type Db = NodePgDatabase<typeof schema>;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

let orgId: string;
let evtId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Ops ${run}`, slug: `ops-${run}` })
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
      emailHash: `ops_${run}`,
    })
    .returning({ id: schema.guests.id });

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const [booking] = await db
    .insert(schema.bookings)
    .values({
      organisationId: orgId,
      venueId: venue!.id,
      serviceId: service!.id,
      areaId: area!.id,
      guestId: guest!.id,
      partySize: 2,
      startAt: start,
      endAt: new Date(start.getTime() + 60 * 60 * 1000),
      status: "confirmed",
      source: "host",
    })
    .returning({ id: schema.bookings.id });

  await db.insert(schema.messages).values([
    {
      organisationId: orgId,
      bookingId: booking!.id,
      channel: "email",
      template: "booking.confirmation",
      status: "delivered",
    },
    {
      organisationId: orgId,
      bookingId: booking!.id,
      channel: "email",
      template: "booking.reminder_24h",
      status: "bounced",
    },
  ]);

  await db.insert(schema.payments).values({
    organisationId: orgId,
    bookingId: booking!.id,
    kind: "deposit",
    stripeIntentId: `pi_fail_${run}`,
    amountMinor: 2000,
    currency: "GBP",
    status: "failed",
  });

  evtId = `evt_test_${run}`;
  await db.insert(schema.stripeEvents).values({
    id: evtId,
    type: "payment_intent.failed",
    payload: {},
    handledAt: new Date(),
  });

  // An overdue DSAR (dueAt in the past, status pending).
  await db.insert(schema.dsarRequests).values({
    organisationId: orgId,
    kind: "erase",
    status: "pending",
    requesterEmailHash: `hash_${run}`,
    requesterEmailCipher: "c",
    dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
});

afterAll(async () => {
  if (orgId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  if (evtId) await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, evtId));
  await pool.end();
});

describe("getOperationsSnapshot", () => {
  it("rolls up message delivery, payment failures, webhook health, and DSARs", async () => {
    const snap = await getOperationsSnapshot(db);

    const email = snap.messages.find((m) => m.channel === "email");
    expect(email?.delivered ?? 0).toBeGreaterThanOrEqual(1);
    expect(email?.bounced ?? 0).toBeGreaterThanOrEqual(1);
    expect((email?.total ?? 0) >= 2).toBe(true);

    const failure = snap.paymentFailures7d.find((r) => r.orgId === orgId);
    expect(failure?.count).toBeGreaterThanOrEqual(1);
    expect(failure?.lastFailureAt).toBeInstanceOf(Date);

    expect(snap.webhooks.totalLast24h).toBeGreaterThanOrEqual(1);
    expect(snap.webhooks.lastReceivedAt).toBeInstanceOf(Date);

    expect(snap.dsars.open).toBeGreaterThanOrEqual(1);
    expect(snap.dsars.overdue).toBeGreaterThanOrEqual(1);
  });
});
