// End-to-end test for the subscription billing webhook lifecycle.
//
// Signs canned customer.subscription.* events and runs them through the
// real verifyAndParse → storeEvent → dispatch path (same as the deposit
// webhook test), asserting organisations.plan tracks the subscription:
//   created(active, core)      → plan 'core'
//   updated(past_due)          → plan still 'core' (access kept while dunning)
//   updated(active, plus)      → plan 'plus' (upgrade)
//   deleted(canceled)          → plan 'free'
// Plus an idempotency check: replaying a stored event is a no-op.
//
// Uses the subscription.* events (object embedded in the payload) so no
// live Stripe API call is needed.

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { _resetStripeClientForTests } from "@/lib/stripe/client";
import "@/lib/stripe/handlers"; // registers billing-subscription handlers
import { dispatch, storeEvent, verifyAndParse } from "@/lib/stripe/webhook";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const FAKE_STRIPE_SECRET_KEY = "sk_test_51" + "b".repeat(100);
const FAKE_WEBHOOK_SECRET = "whsec_" + "b".repeat(40);

function signEvent(body: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${mac}`;
}

const run = Date.now().toString(36);
let orgId: string;
const subId = `sub_lifecycle_${run}`;
let evtSeq = 0;

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) {
  saved[k] = process.env[k];
  process.env[k] = v;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Build a canned subscription.* event. The subscription object carries
// only the fields syncFromSubscription reads.
function subEvent(
  type:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  opts: { status: string; priceId: string; cancelAtPeriodEnd?: boolean },
) {
  return {
    id: `evt_${type}_${opts.status}_${run}_${evtSeq++}`,
    object: "event",
    type,
    data: {
      object: {
        id: subId,
        object: "subscription",
        status: opts.status,
        customer: `cus_${run}`,
        cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
        metadata: { organisation_id: orgId },
        items: {
          data: [
            {
              price: { id: opts.priceId },
              current_period_end: Math.floor(Date.UTC(2026, 11, 1) / 1000),
            },
          ],
        },
      },
    },
  };
}

async function deliver(event: object): Promise<"new" | "duplicate"> {
  const body = JSON.stringify(event);
  const sig = signEvent(body, FAKE_WEBHOOK_SECRET);
  const parsed = verifyAndParse(body, sig);
  const stored = await storeEvent(parsed);
  if (stored === "new") await dispatch(parsed);
  return stored;
}

async function planNow(): Promise<string> {
  const [o] = await db
    .select({ plan: schema.organisations.plan })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, orgId));
  return o!.plan;
}

beforeAll(async () => {
  setEnv("STRIPE_SECRET_KEY", FAKE_STRIPE_SECRET_KEY);
  setEnv("STRIPE_WEBHOOK_SECRET", FAKE_WEBHOOK_SECRET);
  setEnv("STRIPE_PRICE_CORE", "price_core_123");
  setEnv("STRIPE_PRICE_PLUS", "price_plus_456");
  _resetStripeClientForTests();

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `BWH ${run}`, slug: `bwh-${run}`, plan: "free" })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;
});

afterAll(async () => {
  restoreEnv();
  _resetStripeClientForTests();
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("subscription webhook lifecycle → organisations.plan", () => {
  it("created(active, core) sets plan=core and records the subscription", async () => {
    await deliver(
      subEvent("customer.subscription.created", { status: "active", priceId: "price_core_123" }),
    );
    expect(await planNow()).toBe("core");
    const [sub] = await db
      .select({
        status: schema.billingSubscriptions.status,
        plan: schema.billingSubscriptions.plan,
      })
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organisationId, orgId));
    expect(sub).toMatchObject({ status: "active", plan: "core" });
  });

  it("updated(past_due) keeps access (plan stays core)", async () => {
    await deliver(
      subEvent("customer.subscription.updated", { status: "past_due", priceId: "price_core_123" }),
    );
    expect(await planNow()).toBe("core");
  });

  it("updated(active, plus) upgrades the plan", async () => {
    await deliver(
      subEvent("customer.subscription.updated", { status: "active", priceId: "price_plus_456" }),
    );
    expect(await planNow()).toBe("plus");
  });

  it("deleted(canceled) drops to free", async () => {
    await deliver(
      subEvent("customer.subscription.deleted", { status: "canceled", priceId: "price_plus_456" }),
    );
    expect(await planNow()).toBe("free");
  });

  it("replaying a stored event is a no-op (idempotent)", async () => {
    const evt = subEvent("customer.subscription.updated", {
      status: "active",
      priceId: "price_core_123",
    });
    expect(await deliver(evt)).toBe("new");
    expect(await planNow()).toBe("core");
    // Same event id again → stored as duplicate, dispatch skipped.
    expect(await deliver(evt)).toBe("duplicate");
    expect(await planNow()).toBe("core");
  });
});
