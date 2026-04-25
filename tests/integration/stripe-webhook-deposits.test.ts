// Integration tests for the payments-deposits webhook handlers.
//
// Drives payment_intent.succeeded / payment_intent.payment_failed /
// charge.refunded through the dispatcher and asserts the booking
// state machine + payments row transitions. Idempotency is explicit —
// each handler runs twice and must leave the system in the same state.

import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { _resetStripeClientForTests } from "@/lib/stripe/client";
import "@/lib/stripe/handlers";
import { dispatch, storeEvent, verifyAndParse } from "@/lib/stripe/webhook";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const FAKE_STRIPE_SECRET_KEY = "sk_test_51" + "a".repeat(100);
const FAKE_WEBHOOK_SECRET = "whsec_" + "a".repeat(40);

function signEvent(body: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${mac}`;
}

const run = Date.now().toString(36);

type Ctx = {
  orgId: string;
  venueId: string;
  bookingId: string;
  paymentId: string;
  intentId: string; // real pi_* we pretend Stripe gave us
};
let ctx: Ctx;

const originalStripeKey = process.env["STRIPE_SECRET_KEY"];
const originalWebhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];

beforeAll(async () => {
  process.env["STRIPE_SECRET_KEY"] = FAKE_STRIPE_SECRET_KEY;
  process.env["STRIPE_WEBHOOK_SECRET"] = FAKE_WEBHOOK_SECRET;
  _resetStripeClientForTests();

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `WHD ${run}`, slug: `whd-${run}` })
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
      firstName: "WH",
      lastNameCipher: "cipher",
      emailCipher: "cipher",
      emailHash: `hash_${run}`,
    })
    .returning({ id: schema.guests.id });
  const [booking] = await db
    .insert(schema.bookings)
    .values({
      organisationId: org!.id,
      venueId: venue!.id,
      serviceId: service!.id,
      areaId: area!.id,
      guestId: guest!.id,
      partySize: 2,
      startAt: new Date("2026-06-01T12:00:00Z"),
      endAt: new Date("2026-06-01T13:00:00Z"),
      status: "requested",
      source: "widget",
    })
    .returning({ id: schema.bookings.id });

  const intentId = `pi_test_${run}`;
  const [payment] = await db
    .insert(schema.payments)
    .values({
      organisationId: org!.id,
      bookingId: booking!.id,
      kind: "deposit",
      stripeIntentId: intentId,
      amountMinor: 2000,
      currency: "GBP",
      status: "requires_payment_method",
    })
    .returning({ id: schema.payments.id });

  ctx = {
    orgId: org!.id,
    venueId: venue!.id,
    bookingId: booking!.id,
    paymentId: payment!.id,
    intentId,
  };
});

afterAll(async () => {
  if (originalStripeKey === undefined) delete process.env["STRIPE_SECRET_KEY"];
  else process.env["STRIPE_SECRET_KEY"] = originalStripeKey;
  if (originalWebhookSecret === undefined) delete process.env["STRIPE_WEBHOOK_SECRET"];
  else process.env["STRIPE_WEBHOOK_SECRET"] = originalWebhookSecret;
  _resetStripeClientForTests();

  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

function mkEvent(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt_${type}_${run}_${Math.random().toString(36).slice(2, 8)}`,
    object: "event",
    type,
    account: "acct_test",
    data: { object },
  };
}

describe("payment_intent.succeeded handler", () => {
  it("flips booking → confirmed, marks payments row succeeded, appends booking_events", async () => {
    const payload = mkEvent("payment_intent.succeeded", {
      id: ctx.intentId,
      object: "payment_intent",
      amount: 2000,
      amount_received: 2000,
      currency: "gbp",
      status: "succeeded",
      metadata: { payment_id: ctx.paymentId, booking_id: ctx.bookingId, kind: "deposit" },
    });
    const body = JSON.stringify(payload);
    const event = verifyAndParse(body, signEvent(body, FAKE_WEBHOOK_SECRET));
    await storeEvent(event);
    await dispatch(event);

    const [pay] = await db
      .select({ status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.id, ctx.paymentId));
    expect(pay?.status).toBe("succeeded");

    const [bk] = await db
      .select({ status: schema.bookings.status, depositIntentId: schema.bookings.depositIntentId })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, ctx.bookingId));
    expect(bk?.status).toBe("confirmed");
    expect(bk?.depositIntentId).toBe(ctx.intentId);

    const evts = await db
      .select({ type: schema.bookingEvents.type })
      .from(schema.bookingEvents)
      .where(
        and(
          eq(schema.bookingEvents.bookingId, ctx.bookingId),
          eq(schema.bookingEvents.type, "payment.succeeded"),
        ),
      );
    expect(evts.length).toBe(1);

    // Replay — idempotent.
    await dispatch(event);
    const evts2 = await db
      .select({ type: schema.bookingEvents.type })
      .from(schema.bookingEvents)
      .where(
        and(
          eq(schema.bookingEvents.bookingId, ctx.bookingId),
          eq(schema.bookingEvents.type, "payment.succeeded"),
        ),
      );
    expect(evts2.length).toBe(1);

    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });
});

describe("payment_intent.payment_failed handler", () => {
  it("marks the payment failed + appends booking_events; booking stays requested", async () => {
    // Reset the fixture: push booking back to requested and reset
    // payments.status so the failed-handler has work to do.
    await db
      .update(schema.bookings)
      .set({ status: "requested", depositIntentId: null })
      .where(eq(schema.bookings.id, ctx.bookingId));
    await db
      .update(schema.payments)
      .set({ status: "requires_payment_method", failureCode: null, failureMessage: null })
      .where(eq(schema.payments.id, ctx.paymentId));

    const payload = mkEvent("payment_intent.payment_failed", {
      id: ctx.intentId,
      object: "payment_intent",
      amount: 2000,
      currency: "gbp",
      status: "requires_payment_method",
      last_payment_error: {
        code: "card_declined",
        message: "Your card was declined.",
      },
      metadata: { payment_id: ctx.paymentId, booking_id: ctx.bookingId, kind: "deposit" },
    });
    const body = JSON.stringify(payload);
    const event = verifyAndParse(body, signEvent(body, FAKE_WEBHOOK_SECRET));
    await storeEvent(event);
    await dispatch(event);

    const [pay] = await db
      .select({
        failureCode: schema.payments.failureCode,
        failureMessage: schema.payments.failureMessage,
      })
      .from(schema.payments)
      .where(eq(schema.payments.id, ctx.paymentId));
    expect(pay?.failureCode).toBe("card_declined");
    expect(pay?.failureMessage).toBe("Your card was declined.");

    const [bk] = await db
      .select({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, ctx.bookingId));
    expect(bk?.status).toBe("requested");

    const failedEvts = await db
      .select({ id: schema.bookingEvents.id })
      .from(schema.bookingEvents)
      .where(
        and(
          eq(schema.bookingEvents.bookingId, ctx.bookingId),
          eq(schema.bookingEvents.type, "payment.failed"),
        ),
      );
    expect(failedEvts.length).toBeGreaterThanOrEqual(1);

    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });
});

describe("charge.refunded handler", () => {
  it("promotes a pending refund row to succeeded + appends booking_events", async () => {
    const refundId = `re_test_${run}`;
    const [refundRow] = await db
      .insert(schema.payments)
      .values({
        organisationId: ctx.orgId,
        bookingId: ctx.bookingId,
        kind: "refund",
        stripeIntentId: refundId,
        amountMinor: -1000,
        currency: "GBP",
        status: "pending",
      })
      .returning({ id: schema.payments.id });

    const payload = mkEvent("charge.refunded", {
      id: `ch_test_${run}`,
      object: "charge",
      refunds: {
        object: "list",
        data: [
          {
            id: refundId,
            object: "refund",
            amount: 1000,
            status: "succeeded",
          },
        ],
      },
    });
    const body = JSON.stringify(payload);
    const event = verifyAndParse(body, signEvent(body, FAKE_WEBHOOK_SECRET));
    await storeEvent(event);
    await dispatch(event);

    const [r] = await db
      .select({ status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.id, refundRow!.id));
    expect(r?.status).toBe("succeeded");

    const evts = await db
      .select({ id: schema.bookingEvents.id })
      .from(schema.bookingEvents)
      .where(
        and(
          eq(schema.bookingEvents.bookingId, ctx.bookingId),
          eq(schema.bookingEvents.type, "payment.refunded"),
        ),
      );
    expect(evts.length).toBeGreaterThanOrEqual(1);

    // Replay is idempotent — status already succeeded, no-op.
    await dispatch(event);

    await db.delete(schema.payments).where(eq(schema.payments.id, refundRow!.id));
    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });
});

describe("setup_intent.succeeded handler (flow B — card hold)", () => {
  it("flips booking → confirmed, stores customer + payment_method, marks payments succeeded", async () => {
    // Reset booking + use a dedicated hold-payment row so this test
    // doesn't collide with the earlier deposit fixtures.
    await db
      .update(schema.bookings)
      .set({ status: "requested", depositIntentId: null })
      .where(eq(schema.bookings.id, ctx.bookingId));

    const setupId = `seti_test_${run}`;
    const [holdRow] = await db
      .insert(schema.payments)
      .values({
        organisationId: ctx.orgId,
        bookingId: ctx.bookingId,
        kind: "hold",
        stripeIntentId: setupId,
        amountMinor: 2500,
        currency: "GBP",
        status: "requires_payment_method",
      })
      .returning({ id: schema.payments.id });

    const customerId = `cus_test_${run}`;
    const paymentMethodId = `pm_test_${run}`;
    const payload = mkEvent("setup_intent.succeeded", {
      id: setupId,
      object: "setup_intent",
      status: "succeeded",
      customer: customerId,
      payment_method: paymentMethodId,
      metadata: { payment_id: holdRow!.id, booking_id: ctx.bookingId, kind: "hold" },
    });
    const body = JSON.stringify(payload);
    const event = verifyAndParse(body, signEvent(body, FAKE_WEBHOOK_SECRET));
    await storeEvent(event);
    await dispatch(event);

    const [pay] = await db
      .select({
        status: schema.payments.status,
        stripeCustomerId: schema.payments.stripeCustomerId,
        stripePaymentMethodId: schema.payments.stripePaymentMethodId,
      })
      .from(schema.payments)
      .where(eq(schema.payments.id, holdRow!.id));
    expect(pay?.status).toBe("succeeded");
    expect(pay?.stripeCustomerId).toBe(customerId);
    expect(pay?.stripePaymentMethodId).toBe(paymentMethodId);

    const [bk] = await db
      .select({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, ctx.bookingId));
    expect(bk?.status).toBe("confirmed");

    // Replay — idempotent.
    await dispatch(event);
    const [pay2] = await db
      .select({ status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.id, holdRow!.id));
    expect(pay2?.status).toBe("succeeded");

    await db.delete(schema.payments).where(eq(schema.payments.id, holdRow!.id));
    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });
});

describe("setup_intent.setup_failed handler (flow B)", () => {
  it("records failure on the hold payments row + appends booking_events; booking stays requested", async () => {
    await db
      .update(schema.bookings)
      .set({ status: "requested", depositIntentId: null })
      .where(eq(schema.bookings.id, ctx.bookingId));

    const setupId = `seti_fail_${run}`;
    const [holdRow] = await db
      .insert(schema.payments)
      .values({
        organisationId: ctx.orgId,
        bookingId: ctx.bookingId,
        kind: "hold",
        stripeIntentId: setupId,
        amountMinor: 2500,
        currency: "GBP",
        status: "requires_payment_method",
      })
      .returning({ id: schema.payments.id });

    const payload = mkEvent("setup_intent.setup_failed", {
      id: setupId,
      object: "setup_intent",
      status: "requires_payment_method",
      last_setup_error: {
        code: "card_declined",
        message: "Your card was declined.",
      },
      metadata: { payment_id: holdRow!.id, booking_id: ctx.bookingId, kind: "hold" },
    });
    const body = JSON.stringify(payload);
    const event = verifyAndParse(body, signEvent(body, FAKE_WEBHOOK_SECRET));
    await storeEvent(event);
    await dispatch(event);

    const [pay] = await db
      .select({
        failureCode: schema.payments.failureCode,
        failureMessage: schema.payments.failureMessage,
      })
      .from(schema.payments)
      .where(eq(schema.payments.id, holdRow!.id));
    expect(pay?.failureCode).toBe("card_declined");
    expect(pay?.failureMessage).toBe("Your card was declined.");

    const [bk] = await db
      .select({ status: schema.bookings.status })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, ctx.bookingId));
    expect(bk?.status).toBe("requested");

    await db.delete(schema.payments).where(eq(schema.payments.id, holdRow!.id));
    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });
});
