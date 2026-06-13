// Integration test for the Square webhook handler.
//
//   * a validly-signed payment.updated(COMPLETED) ingests a pos_orders row;
//   * a forged signature is rejected with 400 and writes nothing;
//   * a replay of the same event_id is a 200 no-op (idempotent).

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Configure the verifier before the module-under-test reads env at call time.
process.env["SQUARE_WEBHOOK_SIGNATURE_KEY"] = "sq-test-signature-key";
process.env["SQUARE_WEBHOOK_URL"] = "https://api.tablekit.uk/api/webhooks/pos/square";

import * as schema from "@/lib/db/schema";
import { upsertPosConnection } from "@/lib/pos/connection";
import { computeSquareSignature } from "@/lib/pos/square/verify";
import { handleSquareWebhook } from "@/lib/pos/square/webhook";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const MERCHANT = `merchant-${run}`;
const KEY = process.env["SQUARE_WEBHOOK_SIGNATURE_KEY"]!;
const URL_ = process.env["SQUARE_WEBHOOK_URL"]!;

type Ctx = { orgId: string; venueId: string; connId: string };
let ctx: Ctx;

function squareEvent(eventId: string, orderId: string, totalMinor: number): string {
  return JSON.stringify({
    merchant_id: MERCHANT,
    type: "payment.updated",
    event_id: eventId,
    data: {
      object: {
        payment: {
          id: `pay-${orderId}`,
          status: "COMPLETED",
          order_id: orderId,
          location_id: "loc-1",
          total_money: { amount: totalMinor, currency: "GBP" },
          tip_money: { amount: 0, currency: "GBP" },
          updated_at: "2026-05-10T20:00:00Z",
          card_details: { card: { card_brand: "VISA", last_4: "4242" } },
        },
      },
    },
  });
}

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-SQ ${run}`, slug: `pos-sq-${run}`, plan: "plus" })
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
    provider: "square",
    externalAccountId: MERCHANT,
    accessToken: "sq-access-token",
  });

  ctx = { orgId: org!.id, venueId: venue!.id, connId };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

describe("Square webhook", () => {
  it("ingests a validly-signed completed payment", async () => {
    const body = squareEvent(`evt-${run}`, `order-${run}`, 5500);
    const sig = computeSquareSignature(KEY, URL_, body);
    const outcome = await handleSquareWebhook(body, sig);
    expect(outcome).toEqual({ status: 200, result: "ingested" });

    const [order] = await db
      .select({ total: schema.posOrders.totalMinor, label: schema.posOrders.paymentMethodLabel })
      .from(schema.posOrders)
      .where(
        and(
          eq(schema.posOrders.connectionId, ctx.connId),
          eq(schema.posOrders.externalOrderId, `pay-order-${run}`),
        ),
      );
    expect(order?.total).toBe(5500);
    expect(order?.label).toBe("VISA ••4242");
  });

  it("rejects a forged signature with 400 and writes nothing", async () => {
    const body = squareEvent(`evt-forged-${run}`, `order-forged-${run}`, 9900);
    const outcome = await handleSquareWebhook(body, "not-a-valid-signature");
    expect(outcome.status).toBe(400);

    const rows = await db
      .select({ id: schema.posOrders.id })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.externalOrderId, `pay-order-forged-${run}`));
    expect(rows).toHaveLength(0);
  });

  it("treats a replayed event_id as a 200 no-op", async () => {
    const body = squareEvent(`evt-replay-${run}`, `order-replay-${run}`, 1200);
    const sig = computeSquareSignature(KEY, URL_, body);
    const first = await handleSquareWebhook(body, sig);
    expect(first.result).toBe("ingested");
    const second = await handleSquareWebhook(body, sig);
    expect(second).toEqual({ status: 200, result: "duplicate" });

    const rows = await db
      .select({ id: schema.posOrders.id })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.externalOrderId, `pay-order-replay-${run}`));
    expect(rows).toHaveLength(1);
  });
});
