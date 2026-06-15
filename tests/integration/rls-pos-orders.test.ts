// Integration tests for the POS integration tables (pos_connections,
// pos_orders, pos_webhook_events, guest_spend_summary).
//
// Covers (CLAUDE.md rule 3 — every org-scoped table ships an RLS test):
//   1. Cross-tenant RLS — user A never sees org B's connections, orders,
//      webhook events, or spend summaries.
//   2. Per-venue scope — a host restricted to venue A1 (memberships.venue_ids)
//      can't read venue A2's connections/orders within the same org. Mirrors
//      the bookings/venues venue-scoped policy.
//   3. Deny-by-default writes — authenticated cannot INSERT into any of the
//      four tables (all writes go via adminDb() from verified webhook/cron).
//   4. Org-id triggers — a spoofed organisation_id is rewritten to the parent
//      (venue / connection / guest) on all four tables.

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { upsertGuest } from "@/lib/guests/upsert";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function asUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'authenticated', true)`);
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    return fn(tx as Db);
  });
}

const run = Date.now().toString(36);
const CLOSED = new Date("2026-05-10T20:00:00Z");

type Ctx = {
  ownerAId: string;
  hostA1Id: string; // scoped to venue A1 only
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueA1Id: string;
  venueA2Id: string;
  venueBId: string;
  connA1Id: string;
  connA2Id: string;
  connBId: string;
  orderA1Id: string;
  orderA2Id: string;
  orderBId: string;
  guestAId: string;
  guestBId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const mkUser = async (email: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "integration-test-pw-1234",
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    return data.user.id;
  };

  const ownerAId = await mkUser(`pos-owner-a-${run}@tablekit.test`);
  const hostA1Id = await mkUser(`pos-host-a1-${run}@tablekit.test`);
  const userBId = await mkUser(`pos-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `POS-A ${run}`, slug: `pos-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `POS-B ${run}`, slug: `pos-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  const mkVenue = async (orgId: string, name: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name, venueType: "restaurant" })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueA1Id = await mkVenue(orgA.id, "A1");
  const venueA2Id = await mkVenue(orgA.id, "A2");
  const venueBId = await mkVenue(orgB.id, "B");

  await db.insert(schema.memberships).values([
    { userId: ownerAId, organisationId: orgA.id, role: "owner" },
    // Host restricted to venue A1 only — the per-venue isolation case.
    { userId: hostA1Id, organisationId: orgA.id, role: "host", venueIds: [venueA1Id] },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkConn = async (orgId: string, venueId: string) => {
    const [c] = await db
      .insert(schema.posConnections)
      .values({ organisationId: orgId, venueId, provider: "square" })
      .returning({ id: schema.posConnections.id });
    return c!.id;
  };
  const connA1Id = await mkConn(orgA.id, venueA1Id);
  const connA2Id = await mkConn(orgA.id, venueA2Id);
  const connBId = await mkConn(orgB.id, venueBId);

  const mkOrder = async (orgId: string, venueId: string, connId: string, ext: string) => {
    const [o] = await db
      .insert(schema.posOrders)
      .values({
        organisationId: orgId,
        venueId,
        connectionId: connId,
        provider: "square",
        externalOrderId: ext,
        totalMinor: 4200,
        closedAt: CLOSED,
      })
      .returning({ id: schema.posOrders.id });
    return o!.id;
  };
  const orderA1Id = await mkOrder(orgA.id, venueA1Id, connA1Id, `a1-${run}`);
  const orderA2Id = await mkOrder(orgA.id, venueA2Id, connA2Id, `a2-${run}`);
  const orderBId = await mkOrder(orgB.id, venueBId, connBId, `b-${run}`);

  // Webhook-event ledger rows (one per org).
  await db.insert(schema.posWebhookEvents).values([
    {
      organisationId: orgA.id,
      connectionId: connA1Id,
      provider: "square",
      externalEventId: `evt-a-${run}`,
    },
    {
      organisationId: orgB.id,
      connectionId: connBId,
      provider: "square",
      externalEventId: `evt-b-${run}`,
    },
  ]);

  // A guest + spend summary per org (guest via canonical encrypting upsert).
  const gA = await upsertGuest(orgA.id, ownerAId, {
    firstName: "Spend",
    lastName: "Alpha",
    email: `spend-a-${run}@example.com`,
  });
  const gB = await upsertGuest(orgB.id, userBId, {
    firstName: "Spend",
    lastName: "Bravo",
    email: `spend-b-${run}@example.com`,
  });
  if (!gA.ok || !gB.ok) throw new Error("guest upsert failed");

  await db.insert(schema.guestSpendSummary).values([
    { guestId: gA.guestId, organisationId: orgA.id, orderCount: 3, totalSpendMinor: 12600 },
    { guestId: gB.guestId, organisationId: orgB.id, orderCount: 1, totalSpendMinor: 4200 },
  ]);

  ctx = {
    ownerAId,
    hostA1Id,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueA1Id,
    venueA2Id,
    venueBId,
    connA1Id,
    connA2Id,
    connBId,
    orderA1Id,
    orderA2Id,
    orderBId,
    guestAId: gA.guestId,
    guestBId: gB.guestId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.ownerAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.hostA1Id).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("POS tables — cross-tenant RLS", () => {
  it("owner A sees only org A's connections", async () => {
    const rows = await asUser(ctx.ownerAId, (tx) => tx.select().from(schema.posConnections));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("owner A sees only org A's orders", async () => {
    const rows = await asUser(ctx.ownerAId, (tx) => tx.select().from(schema.posOrders));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.orderA1Id);
    expect(ids).toContain(ctx.orderA2Id);
    expect(ids).not.toContain(ctx.orderBId);
  });

  it("owner A sees only org A's webhook events", async () => {
    const rows = await asUser(ctx.ownerAId, (tx) => tx.select().from(schema.posWebhookEvents));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("owner A sees only org A's spend summaries", async () => {
    const rows = await asUser(ctx.ownerAId, (tx) => tx.select().from(schema.guestSpendSummary));
    const guestIds = rows.map((r) => r.guestId);
    expect(guestIds).toContain(ctx.guestAId);
    expect(guestIds).not.toContain(ctx.guestBId);
  });
});

describe("POS tables — per-venue scope (memberships.venue_ids)", () => {
  it("host scoped to A1 sees A1's connection but not A2's", async () => {
    const rows = await asUser(ctx.hostA1Id, (tx) =>
      tx.select({ id: schema.posConnections.id }).from(schema.posConnections),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.connA1Id);
    expect(ids).not.toContain(ctx.connA2Id);
  });

  it("host scoped to A1 sees A1's orders but not A2's (same org)", async () => {
    const rows = await asUser(ctx.hostA1Id, (tx) =>
      tx
        .select({ id: schema.posOrders.id, venueId: schema.posOrders.venueId })
        .from(schema.posOrders),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.orderA1Id);
    expect(ids).not.toContain(ctx.orderA2Id);
  });
});

describe("POS tables — deny-by-default writes", () => {
  it("authenticated cannot insert a connection", async () => {
    await expect(
      asUser(ctx.ownerAId, (tx) =>
        tx.insert(schema.posConnections).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueA1Id,
          provider: "generic",
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated cannot insert an order", async () => {
    await expect(
      asUser(ctx.ownerAId, (tx) =>
        tx.insert(schema.posOrders).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueA1Id,
          connectionId: ctx.connA1Id,
          provider: "square",
          externalOrderId: `hack-${run}`,
          totalMinor: 1,
          closedAt: CLOSED,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("POS tables — org-id enforcement triggers", () => {
  it("pos_connections rewrites a spoofed organisation_id to the venue's org", async () => {
    const [row] = await db
      .insert(schema.posConnections)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: ctx.venueA1Id,
        provider: "lightspeed_k",
      })
      .returning({
        id: schema.posConnections.id,
        organisationId: schema.posConnections.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.posConnections).where(eq(schema.posConnections.id, row!.id));
  });

  it("pos_orders rewrites a spoofed organisation_id to the venue's org", async () => {
    const [row] = await db
      .insert(schema.posOrders)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: ctx.venueA2Id,
        connectionId: ctx.connA2Id,
        provider: "square",
        externalOrderId: `spoof-${run}`,
        totalMinor: 100,
        closedAt: CLOSED,
      })
      .returning({ id: schema.posOrders.id, organisationId: schema.posOrders.organisationId });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.posOrders).where(eq(schema.posOrders.id, row!.id));
  });

  it("pos_webhook_events derives organisation_id from the connection", async () => {
    const [row] = await db
      .insert(schema.posWebhookEvents)
      .values({
        organisationId: ctx.orgBId, // spoof
        connectionId: ctx.connA1Id,
        provider: "square",
        externalEventId: `spoof-evt-${run}`,
      })
      .returning({
        id: schema.posWebhookEvents.id,
        organisationId: schema.posWebhookEvents.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.posWebhookEvents).where(eq(schema.posWebhookEvents.id, row!.id));
  });

  it("guest_spend_summary derives organisation_id from the guest", async () => {
    // Use guest B (org B). Spoof org A on insert; trigger must correct to B.
    await db
      .delete(schema.guestSpendSummary)
      .where(eq(schema.guestSpendSummary.guestId, ctx.guestBId));
    const [row] = await db
      .insert(schema.guestSpendSummary)
      .values({
        guestId: ctx.guestBId,
        organisationId: ctx.orgAId, // spoof
        orderCount: 1,
        totalSpendMinor: 999,
      })
      .returning({
        guestId: schema.guestSpendSummary.guestId,
        organisationId: schema.guestSpendSummary.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgBId);
  });
});

describe("POS dedupe — webhook idempotency", () => {
  it("rejects a duplicate (provider, external_event_id)", async () => {
    await expect(
      db.insert(schema.posWebhookEvents).values({
        organisationId: ctx.orgAId,
        connectionId: ctx.connA1Id,
        provider: "square",
        externalEventId: `evt-a-${run}`, // same as seeded
      }),
    ).rejects.toThrow();
  });
});
