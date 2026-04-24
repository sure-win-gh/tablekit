// End-to-end test for the webhook machinery:
//   1. Seed a stripe_accounts row for an org.
//   2. Sign a canned `account.updated` event with the configured
//      webhook secret.
//   3. Call verifyAndParse → storeEvent → dispatch.
//   4. Assert the stripe_accounts row is updated and the event's
//      handled_at is set.
//
// The test works against the real DB fixture and the real Stripe
// SDK's signature verification (no mocking). It sidesteps the HTTP
// route — that's wired in task 7 and its own smoke.

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { _resetStripeClientForTests } from "@/lib/stripe/client";
import "@/lib/stripe/handlers"; // register account.updated handler
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
let orgId: string;
let accountId: string;

const originalStripeKey = process.env["STRIPE_SECRET_KEY"];
const originalWebhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];

beforeAll(async () => {
  process.env["STRIPE_SECRET_KEY"] = FAKE_STRIPE_SECRET_KEY;
  process.env["STRIPE_WEBHOOK_SECRET"] = FAKE_WEBHOOK_SECRET;
  _resetStripeClientForTests();

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Webhook ${run}`, slug: `wh-${run}` })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;

  accountId = `acct_webhook_${run}`;
  await db.insert(schema.stripeAccounts).values({
    organisationId: orgId,
    accountId,
  });
});

afterAll(async () => {
  if (originalStripeKey === undefined) delete process.env["STRIPE_SECRET_KEY"];
  else process.env["STRIPE_SECRET_KEY"] = originalStripeKey;
  if (originalWebhookSecret === undefined) delete process.env["STRIPE_WEBHOOK_SECRET"];
  else process.env["STRIPE_WEBHOOK_SECRET"] = originalWebhookSecret;
  _resetStripeClientForTests();

  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("stripe webhook — account.updated", () => {
  it("verifies, stores, dispatches, and updates the stripe_accounts row", async () => {
    const payload = {
      id: `evt_wh_${run}`,
      object: "event",
      type: "account.updated",
      data: {
        object: {
          id: accountId,
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          country: "GB",
          default_currency: "gbp",
        },
      },
    };
    const body = JSON.stringify(payload);
    const sig = signEvent(body, FAKE_WEBHOOK_SECRET);

    const event = verifyAndParse(body, sig);
    expect(event.id).toBe(payload.id);

    const storeResult = await storeEvent(event);
    expect(storeResult).toBe("new");

    const dispatched = await dispatch(event);
    expect(dispatched).toBe("handled");

    const [row] = await db
      .select()
      .from(schema.stripeAccounts)
      .where(eq(schema.stripeAccounts.accountId, accountId));
    expect(row?.chargesEnabled).toBe(true);
    expect(row?.payoutsEnabled).toBe(true);
    expect(row?.detailsSubmitted).toBe(true);
    expect(row?.country).toBe("GB");
    expect(row?.defaultCurrency).toBe("GBP");

    const [eventRow] = await db
      .select()
      .from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.id, event.id));
    expect(eventRow?.handledAt).not.toBeNull();

    // Clean up.
    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });

  it("duplicate delivery is a no-op", async () => {
    const payload = {
      id: `evt_dup_${run}`,
      object: "event",
      type: "account.updated",
      data: {
        object: {
          id: accountId,
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          country: "GB",
          default_currency: "gbp",
        },
      },
    };
    const body = JSON.stringify(payload);
    const sig = signEvent(body, FAKE_WEBHOOK_SECRET);
    const event = verifyAndParse(body, sig);

    const a = await storeEvent(event);
    expect(a).toBe("new");

    const b = await storeEvent(event);
    expect(b).toBe("duplicate");

    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });
});
