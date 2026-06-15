// Integration test for the manual-attach core. An operator links an
// unmatched POS order to a guest by hand → match_method='manual', guest_id
// set, spend recomputed, audit written. Cross-org orders/guests are rejected.

import { and, desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { upsertGuest } from "@/lib/guests/upsert";
import { ingestOrder } from "@/lib/pos/ingest";
import { attachOrderToGuestForOrg } from "@/lib/pos/manual-attach";
import type { NormalisedOrder } from "@/lib/pos/types";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);

function order(ext: string): NormalisedOrder {
  return {
    provider: "generic",
    externalOrderId: ext,
    totalMinor: 5000,
    tipMinor: 0,
    taxMinor: null,
    currency: "GBP",
    coverCount: 2,
    paymentMethodLabel: "Cash",
    closedAt: new Date("2026-05-10T20:00:00Z"),
    customerEmail: null, // forces unmatched
    customerPhone: null,
    bookingRef: null,
    lineItems: null,
    rawProviderRef: null,
  };
}

type Ctx = {
  orgId: string;
  otherOrgId: string;
  venueId: string;
  connId: string;
  guestId: string;
  otherGuestId: string;
  orderId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-MA ${run}`, slug: `pos-ma-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [other] = await db
    .insert(schema.organisations)
    .values({ name: `POS-MA-O ${run}`, slug: `pos-ma-o-${run}`, plan: "plus" })
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
    firstName: "Attach",
    lastName: "Target",
    email: `pos-ma-${run}@example.com`,
  });
  const og = await upsertGuest(other!.id, null, {
    firstName: "Other",
    lastName: "Org",
    email: `pos-ma-o-${run}@example.com`,
  });
  if (!g.ok || !og.ok) throw new Error("guest upsert failed");

  const res = await ingestOrder({
    connectionId: conn!.id,
    organisationId: org!.id,
    venueId: venue!.id,
    lineItemsEnabled: false,
    groupCrmEnabled: false,
    order: order(`ma-${run}`),
  });

  ctx = {
    orgId: org!.id,
    otherOrgId: other!.id,
    venueId: venue!.id,
    connId: conn!.id,
    guestId: g.guestId,
    otherGuestId: og.guestId,
    orderId: res.orderId,
  };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.otherOrgId));
  }
  await pool.end();
});

describe("attachOrderToGuestForOrg", () => {
  it("the seeded order starts unmatched", async () => {
    const [o] = await db
      .select({ guestId: schema.posOrders.guestId, matchMethod: schema.posOrders.matchMethod })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.id, ctx.orderId));
    expect(o?.guestId).toBeNull();
    expect(o?.matchMethod).toBeNull();
  });

  it("attaches the order to the guest with match_method='manual', rolls up spend, audits", async () => {
    const result = await attachOrderToGuestForOrg({
      orgId: ctx.orgId,
      orderId: ctx.orderId,
      guestId: ctx.guestId,
    });
    expect(result.ok).toBe(true);

    const [o] = await db
      .select({ guestId: schema.posOrders.guestId, matchMethod: schema.posOrders.matchMethod })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.id, ctx.orderId));
    expect(o?.guestId).toBe(ctx.guestId);
    expect(o?.matchMethod).toBe("manual");

    const [summary] = await db
      .select({
        count: schema.guestSpendSummary.orderCount,
        total: schema.guestSpendSummary.totalSpendMinor,
      })
      .from(schema.guestSpendSummary)
      .where(eq(schema.guestSpendSummary.guestId, ctx.guestId));
    expect(summary?.count).toBe(1);
    expect(Number(summary?.total)).toBe(5000);

    const [auditRow] = await db
      .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.organisationId, ctx.orgId),
          eq(schema.auditLog.action, "pos.order.manual_attached"),
        ),
      )
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(1);
    expect(auditRow?.action).toBe("pos.order.manual_attached");
  });

  it("rejects an order from another org", async () => {
    const result = await attachOrderToGuestForOrg({
      orgId: ctx.otherOrgId, // wrong org for this order
      orderId: ctx.orderId,
      guestId: ctx.otherGuestId,
    });
    expect(result).toEqual({ ok: false, reason: "order-not-found" });
  });

  it("rejects a guest from another org", async () => {
    const result = await attachOrderToGuestForOrg({
      orgId: ctx.orgId,
      orderId: ctx.orderId,
      guestId: ctx.otherGuestId, // guest belongs to the other org
    });
    expect(result).toEqual({ ok: false, reason: "guest-not-found" });
  });
});
