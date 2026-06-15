// Integration test for the generic POS path — signed webhook + CSV import.
//
//   * a correctly-signed JSON body ingests a pos_orders row;
//   * a bad signature is rejected with 400 and writes nothing;
//   * a CSV maps each row to an order (with a per-row reject for bad rows).

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { upsertPosConnection } from "@/lib/pos/connection";
import { ingestPosCsv } from "@/lib/pos/csv/ingest";
import { handleGenericWebhook } from "@/lib/pos/generic/webhook";
import { signBody } from "@/lib/webhooks/sign";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const SECRET = `generic-secret-${run}`;

type Ctx = { orgId: string; venueId: string; connId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-Gen ${run}`, slug: `pos-gen-${run}`, plan: "plus" })
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
    provider: "generic",
    webhookSecret: SECRET,
  });
  ctx = { orgId: org!.id, venueId: venue!.id, connId };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

describe("generic signed webhook", () => {
  it("ingests a correctly-signed JSON body", async () => {
    const body = JSON.stringify({
      external_order_id: `gen-${run}`,
      total_minor: 6400,
      currency: "GBP",
      closed_at: "2026-05-11T19:30:00Z",
      payment_method_label: "Amex ••1009",
    });
    const sig = signBody(SECRET, body);
    const outcome = await handleGenericWebhook({
      connectionId: ctx.connId,
      rawBody: body,
      signatureHeader: sig,
    });
    expect(outcome).toEqual({ status: 200, result: "ingested" });

    const [order] = await db
      .select({ total: schema.posOrders.totalMinor, label: schema.posOrders.paymentMethodLabel })
      .from(schema.posOrders)
      .where(
        and(
          eq(schema.posOrders.connectionId, ctx.connId),
          eq(schema.posOrders.externalOrderId, `gen-${run}`),
        ),
      );
    expect(order?.total).toBe(6400);
    expect(order?.label).toBe("Amex ••1009");
  });

  it("rejects a bad signature with 400 and writes nothing", async () => {
    const body = JSON.stringify({
      external_order_id: `gen-bad-${run}`,
      total_minor: 100,
      closed_at: "2026-05-11T19:30:00Z",
    });
    const outcome = await handleGenericWebhook({
      connectionId: ctx.connId,
      rawBody: body,
      signatureHeader: "sha256=deadbeef",
    });
    expect(outcome.status).toBe(400);
    const rows = await db
      .select({ id: schema.posOrders.id })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.externalOrderId, `gen-bad-${run}`));
    expect(rows).toHaveLength(0);
  });
});

describe("generic CSV import", () => {
  it("maps each valid row to an order and rejects bad rows", async () => {
    const csv = [
      "external_order_id,total_minor,currency,closed_at,payment_method_label",
      `csv-a-${run},2500,GBP,2026-05-12T12:00:00Z,Cash`,
      `csv-b-${run},3700,GBP,2026-05-12T13:00:00Z,Visa ••4242`,
      `csv-bad-${run},notanumber,GBP,2026-05-12T14:00:00Z,Cash`,
    ].join("\n");

    const result = await ingestPosCsv(ctx.connId, csv);
    expect(result.ingested).toBe(2);
    expect(result.rejected.length).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({ ext: schema.posOrders.externalOrderId })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.connectionId, ctx.connId));
    const exts = rows.map((r) => r.ext);
    expect(exts).toContain(`csv-a-${run}`);
    expect(exts).toContain(`csv-b-${run}`);
    expect(exts).not.toContain(`csv-bad-${run}`);
  });
});
