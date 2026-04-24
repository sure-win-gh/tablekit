// Integration test for the deposit-abandonment janitor.
//
// Asserts:
//   1. A stuck booking (status=requested, created_at older than TTL,
//      payment in requires_*) is swept: booking→cancelled with reason
//      deposit_abandoned, payments→canceled, booking_event appended.
//   2. A fresh booking (created_at within TTL) is left alone.
//   3. A booking whose payment is already succeeded is left alone.
//   4. A second run is a no-op — already-cancelled bookings don't
//      match the WHERE clause any more.
//
// We sidestep the Stripe API by using a placeholder `pending_<id>`
// intent id; the janitor skips Stripe calls for non-pi_ ids.

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { sweepAbandonedDeposits, TTL_MINUTES } from "@/lib/payments/janitor";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = {
  orgId: string;
  venueId: string;
  staleBookingId: string;
  freshBookingId: string;
  succeededBookingId: string;
  stalePaymentId: string;
  freshPaymentId: string;
  succeededPaymentId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `JN ${run}`, slug: `jn-${run}` })
    .returning({ id: schema.organisations.id });
  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: org!.id, name: "V", venueType: "cafe", timezone: "Europe/London" })
    .returning({ id: schema.venues.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: org!.id, venueId: venue!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const schedule = {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "08:00",
    end: "17:00",
  };
  const [service] = await db
    .insert(schema.services)
    .values({
      organisationId: org!.id,
      venueId: venue!.id,
      name: "Open",
      schedule,
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });
  const [guest] = await db
    .insert(schema.guests)
    .values({
      organisationId: org!.id,
      firstName: "JN",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: `jh_${run}`,
    })
    .returning({ id: schema.guests.id });

  const mkBooking = async (status: "requested" | "confirmed", agedMinutes: number) => {
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: org!.id,
        venueId: venue!.id,
        serviceId: service!.id,
        areaId: area!.id,
        guestId: guest!.id,
        partySize: 2,
        startAt: new Date("2026-08-01T12:00:00Z"),
        endAt: new Date("2026-08-01T13:00:00Z"),
        status,
        source: "widget",
      })
      .returning({ id: schema.bookings.id });
    // Backdate created_at so the janitor's cutoff filter can see them.
    await db.execute(
      sql`update bookings set created_at = now() - (${agedMinutes} * interval '1 minute') where id = ${b!.id}`,
    );
    return b!.id;
  };

  // Stale: created 30 min ago, status requested, payment requires_payment_method
  const staleBookingId = await mkBooking("requested", TTL_MINUTES + 15);
  // Fresh: created 2 min ago, status requested, payment requires_payment_method
  const freshBookingId = await mkBooking("requested", 2);
  // Succeeded payment: created 30 min ago, status confirmed (won't match anyway)
  const succeededBookingId = await mkBooking("confirmed", TTL_MINUTES + 15);

  const mkPayment = async (bookingId: string, status: string) => {
    const [p] = await db
      .insert(schema.payments)
      .values({
        organisationId: org!.id,
        bookingId,
        kind: "deposit",
        stripeIntentId: `pending_${bookingId}`,
        amountMinor: 2000,
        currency: "GBP",
        status,
      })
      .returning({ id: schema.payments.id });
    return p!.id;
  };
  const stalePaymentId = await mkPayment(staleBookingId, "requires_payment_method");
  const freshPaymentId = await mkPayment(freshBookingId, "requires_payment_method");
  const succeededPaymentId = await mkPayment(succeededBookingId, "succeeded");

  ctx = {
    orgId: org!.id,
    venueId: venue!.id,
    staleBookingId,
    freshBookingId,
    succeededBookingId,
    stalePaymentId,
    freshPaymentId,
    succeededPaymentId,
  };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("sweepAbandonedDeposits", () => {
  it("sweeps stale bookings, leaves fresh ones + already-succeeded ones alone", async () => {
    const result = await sweepAbandonedDeposits();
    expect(result.swept).toBe(1);
    expect(result.failed).toBe(0);

    // Stale: cancelled + deposit_abandoned
    const [stale] = await db
      .select({ status: schema.bookings.status, reason: schema.bookings.cancelledReason })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, ctx.staleBookingId));
    expect(stale?.status).toBe("cancelled");
    expect(stale?.reason).toBe("deposit_abandoned");

    const [stalePay] = await db
      .select({ status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.id, ctx.stalePaymentId));
    expect(stalePay?.status).toBe("canceled");

    const evts = await db
      .select({ id: schema.bookingEvents.id })
      .from(schema.bookingEvents)
      .where(
        and(
          eq(schema.bookingEvents.bookingId, ctx.staleBookingId),
          eq(schema.bookingEvents.type, "booking.deposit.abandoned"),
        ),
      );
    expect(evts.length).toBe(1);

    // Fresh: untouched
    const [fresh] = await db
      .select({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, ctx.freshBookingId));
    expect(fresh?.status).toBe("requested");

    // Succeeded: untouched
    const [suc] = await db
      .select({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, ctx.succeededBookingId));
    expect(suc?.status).toBe("confirmed");
  });

  it("is idempotent — a second run over the same state is a no-op", async () => {
    const result = await sweepAbandonedDeposits();
    expect(result.swept).toBe(0);
    expect(result.failed).toBe(0);
  });
});
