// Integration test for the Lightspeed K-Series webhook handler.
//
//   * with the partner flag OFF, the webhook is disabled (503, no ingest);
//   * with the flag ON, a validly-signed ACCOUNT_CLOSED event ingests;
//   * a forged signature is rejected with 400 and writes nothing.

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { upsertPosConnection } from "@/lib/pos/connection";
import { computeLightspeedSignature } from "@/lib/pos/lightspeed/verify";
import { handleLightspeedWebhook } from "@/lib/pos/lightspeed/webhook";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const BUSINESS = `ls-business-${run}`;
const SECRET = `ls-webhook-secret-${run}`;

type Ctx = { orgId: string; venueId: string; connId: string };
let ctx: Ctx;

function lsEvent(eventId: string, accountId: string, totalMinor: number): string {
  return JSON.stringify({
    business_id: BUSINESS,
    event_id: eventId,
    type: "ACCOUNT_CLOSED",
    account: {
      id: accountId,
      total_amount: totalMinor,
      tip_amount: 0,
      currency: "GBP",
      closed_at: "2026-05-10T21:00:00Z",
      payment_method_label: "Mastercard ••5454",
    },
  });
}

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-LS ${run}`, slug: `pos-ls-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org!.id,
      name: "V",
      venueType: "restaurant",
      timezone: "Europe/London",
    })
    .returning({ id: schema.venues.id });

  const connId = await upsertPosConnection({
    organisationId: org!.id,
    venueId: venue!.id,
    provider: "lightspeed_k",
    externalAccountId: BUSINESS,
    accessToken: "ls-access",
    webhookSecret: SECRET,
  });

  ctx = { orgId: org!.id, venueId: venue!.id, connId };
});

afterEach(() => {
  delete process.env["LIGHTSPEED_PARTNER_ENABLED"];
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

describe("Lightspeed webhook", () => {
  it("is disabled (503) when the partner flag is off", async () => {
    const body = lsEvent(`evt-off-${run}`, `acct-off-${run}`, 4000);
    const sig = computeLightspeedSignature(SECRET, body);
    const outcome = await handleLightspeedWebhook(body, sig);
    expect(outcome).toEqual({ status: 503, result: "disabled" });

    const rows = await db
      .select({ id: schema.posOrders.id })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.externalOrderId, `acct-off-${run}`));
    expect(rows).toHaveLength(0);
  });

  it("ingests a validly-signed ACCOUNT_CLOSED when the flag is on", async () => {
    process.env["LIGHTSPEED_PARTNER_ENABLED"] = "true";
    const body = lsEvent(`evt-on-${run}`, `acct-on-${run}`, 7300);
    const sig = computeLightspeedSignature(SECRET, body);
    const outcome = await handleLightspeedWebhook(body, sig);
    expect(outcome).toEqual({ status: 200, result: "ingested" });

    const [order] = await db
      .select({ total: schema.posOrders.totalMinor, label: schema.posOrders.paymentMethodLabel })
      .from(schema.posOrders)
      .where(
        and(
          eq(schema.posOrders.connectionId, ctx.connId),
          eq(schema.posOrders.externalOrderId, `acct-on-${run}`),
        ),
      );
    expect(order?.total).toBe(7300);
    expect(order?.label).toBe("Mastercard ••5454");
  });

  it("rejects a forged signature with 400 and writes nothing", async () => {
    process.env["LIGHTSPEED_PARTNER_ENABLED"] = "true";
    const body = lsEvent(`evt-forge-${run}`, `acct-forge-${run}`, 5000);
    const outcome = await handleLightspeedWebhook(body, "deadbeef");
    expect(outcome.status).toBe(400);

    const rows = await db
      .select({ id: schema.posOrders.id })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.externalOrderId, `acct-forge-${run}`));
    expect(rows).toHaveLength(0);
  });
});
