// Integration test for the POS retention sweep.
//
//   * orders past the org's window (pos_retention_months ?? 24) are deleted;
//   * orders inside the window survive;
//   * the sweep is bounded (batchSize) and resumable across ticks;
//   * affected guest spend is recomputed after deletion.

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { upsertGuest } from "@/lib/guests/upsert";
import { ingestOrder } from "@/lib/pos/ingest";
import { sweepExpiredPosOrders } from "@/lib/pos/retention";
import type { NormalisedOrder } from "@/lib/pos/types";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const NOW = new Date("2026-06-01T00:00:00Z");

function order(overrides: Partial<NormalisedOrder>): NormalisedOrder {
  return {
    provider: "generic",
    externalOrderId: `ext-${run}`,
    totalMinor: 1000,
    tipMinor: 0,
    taxMinor: null,
    currency: "GBP",
    coverCount: 1,
    paymentMethodLabel: null,
    closedAt: NOW,
    customerEmail: null,
    customerPhone: null,
    bookingRef: null,
    lineItems: null,
    rawProviderRef: null,
    ...overrides,
  };
}

type Ctx = { orgId: string; venueId: string; connId: string; guestId: string };
let ctx: Ctx;

beforeAll(async () => {
  // 12-month retention so "13 months ago" is expired and "1 month ago" survives.
  const [org] = await db
    .insert(schema.organisations)
    .values({
      name: `POS-Ret ${run}`,
      slug: `pos-ret-${run}`,
      plan: "plus",
      posRetentionMonths: 12,
    })
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
  const [conn] = await db
    .insert(schema.posConnections)
    .values({ organisationId: org!.id, venueId: venue!.id, provider: "generic" })
    .returning({ id: schema.posConnections.id });
  const g = await upsertGuest(org!.id, null, {
    firstName: "Ret",
    lastName: "Guest",
    email: `pos-ret-${run}@example.com`,
  });
  if (!g.ok) throw new Error("guest upsert failed");
  ctx = { orgId: org!.id, venueId: venue!.id, connId: conn!.id, guestId: g.guestId };

  const ingest = (ext: string, closedAt: Date) =>
    ingestOrder({
      connectionId: ctx.connId,
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      lineItemsEnabled: false,
      groupCrmEnabled: true, // attribute to the guest regardless of bookings
      order: order({
        externalOrderId: ext,
        customerEmail: `pos-ret-${run}@example.com`,
        closedAt,
        totalMinor: 1000,
      }),
    });

  // Two expired (13, 18 months ago) + one in-window (1 month ago).
  await ingest(`old1-${run}`, new Date("2025-05-01T00:00:00Z"));
  await ingest(`old2-${run}`, new Date("2024-12-01T00:00:00Z"));
  await ingest(`fresh-${run}`, new Date("2026-05-01T00:00:00Z"));
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

describe("sweepExpiredPosOrders", () => {
  it("is bounded by batchSize and resumable across ticks", async () => {
    // Batch of 1 → only the oldest expired order goes this tick.
    const first = await sweepExpiredPosOrders({ now: NOW, batchSize: 1 });
    expect(first.deleted).toBe(1);

    const second = await sweepExpiredPosOrders({ now: NOW, batchSize: 10 });
    expect(second.deleted).toBe(1); // the other expired order

    const third = await sweepExpiredPosOrders({ now: NOW, batchSize: 10 });
    expect(third.deleted).toBe(0); // nothing left expired
  });

  it("keeps in-window orders and deletes only expired ones", async () => {
    const remaining = await db
      .select({ ext: schema.posOrders.externalOrderId })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.connectionId, ctx.connId));
    const exts = remaining.map((r) => r.ext);
    expect(exts).toContain(`fresh-${run}`);
    expect(exts).not.toContain(`old1-${run}`);
    expect(exts).not.toContain(`old2-${run}`);
  });

  it("recomputes guest spend after deletion (only the fresh order counts)", async () => {
    const [summary] = await db
      .select({
        count: schema.guestSpendSummary.orderCount,
        total: schema.guestSpendSummary.totalSpendMinor,
      })
      .from(schema.guestSpendSummary)
      .where(eq(schema.guestSpendSummary.guestId, ctx.guestId));
    expect(summary?.count).toBe(1);
    expect(Number(summary?.total)).toBe(1000);
  });
});
