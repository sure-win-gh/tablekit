// Integration tests for the POS ingest core (match + rollup + idempotency).
//
// Covers (docs/specs/pos-integrations.md acceptance criteria):
//   * email-hash match — the POS-side hash is byte-identical to the
//     guest-side hash, so an order with the guest's email links to them;
//   * booking-link match — an order settled inside a booking's service
//     window at the same venue adopts that booking's guest;
//   * card guard in the pipeline — a card-number-shaped label is stripped;
//   * rollup — guest_spend_summary is recomputed on upsert and is
//     rebuildable from pos_orders alone;
//   * idempotency — re-ingesting the same (connection, external_order_id)
//     updates the one row (no duplicate, no double-count).

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { ingestOrder } from "@/lib/pos/ingest";
import { rebuildGuestSpendForOrg } from "@/lib/pos/rollup";
import type { NormalisedOrder } from "@/lib/pos/types";
import { upsertGuest } from "@/lib/guests/upsert";
import { hashForLookup } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);
const EMAIL = `pos-ingest-${run}@example.com`;

function order(overrides: Partial<NormalisedOrder>): NormalisedOrder {
  return {
    provider: "generic",
    externalOrderId: `ext-${run}`,
    totalMinor: 4200,
    tipMinor: 0,
    taxMinor: null,
    currency: "GBP",
    coverCount: 2,
    paymentMethodLabel: null,
    closedAt: new Date("2026-05-10T20:00:00Z"),
    customerEmail: null,
    customerPhone: null,
    bookingRef: null,
    lineItems: null,
    rawProviderRef: null,
    ...overrides,
  };
}

type Ctx = {
  ownerId: string;
  orgId: string;
  venueId: string;
  serviceId: string;
  areaId: string;
  connId: string;
  guestId: string;
  bookingGuestId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `pos-ingest-owner-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const ownerId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-Ingest ${run}`, slug: `pos-ingest-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert failed");
  await db
    .insert(schema.memberships)
    .values({ userId: ownerId, organisationId: org.id, role: "owner" });

  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org.id,
      name: "V",
      venueType: "restaurant",
      timezone: "Europe/London",
    })
    .returning({ id: schema.venues.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: org.id, venueId: venue!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [svc] = await db
    .insert(schema.services)
    .values({
      organisationId: org.id,
      venueId: venue!.id,
      name: "Dinner",
      schedule: {
        days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        start: "17:00",
        end: "23:00",
      },
      turnMinutes: 120,
    })
    .returning({ id: schema.services.id });

  const [conn] = await db
    .insert(schema.posConnections)
    .values({ organisationId: org.id, venueId: venue!.id, provider: "generic" })
    .returning({ id: schema.posConnections.id });

  // The email-match guest (has a realised booking at the venue → matches
  // even under venue-scoped, group-CRM-off).
  const g = await upsertGuest(org.id, ownerId, {
    firstName: "Ingest",
    lastName: "Guest",
    email: EMAIL,
  });
  if (!g.ok) throw new Error("guest upsert failed");

  // A separate guest tied to a booking, used for the booking-link case.
  const bg = await upsertGuest(org.id, ownerId, {
    firstName: "Booking",
    lastName: "Guest",
    email: `pos-booking-${run}@example.com`,
  });
  if (!bg.ok) throw new Error("booking guest upsert failed");

  // Email-guest realised booking at 18:00–20:00.
  await db.insert(schema.bookings).values({
    organisationId: org.id,
    venueId: venue!.id,
    serviceId: svc!.id,
    areaId: area!.id,
    guestId: g.guestId,
    partySize: 2,
    startAt: new Date("2026-05-10T17:00:00Z"),
    endAt: new Date("2026-05-10T19:00:00Z"),
    status: "finished",
    source: "host",
  });

  ctx = {
    ownerId,
    orgId: org.id,
    venueId: venue!.id,
    serviceId: svc!.id,
    areaId: area!.id,
    connId: conn!.id,
    guestId: g.guestId,
    bookingGuestId: bg.guestId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.ownerId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("POS ingest — email-hash match + identity", () => {
  it("POS-side hash equals the guest-side hash that populated email_hash", async () => {
    const [g] = await db
      .select({ emailHash: schema.guests.emailHash })
      .from(schema.guests)
      .where(eq(schema.guests.id, ctx.guestId));
    expect(g?.emailHash).toBe(hashForLookup(EMAIL, "email"));
  });

  it("links an order carrying the guest's email and rolls up spend", async () => {
    const res = await ingestOrder({
      connectionId: ctx.connId,
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      lineItemsEnabled: false,
      groupCrmEnabled: false,
      order: order({ externalOrderId: `email-${run}`, customerEmail: EMAIL, totalMinor: 5000 }),
    });
    expect(res.guestId).toBe(ctx.guestId);
    expect(res.matchMethod).toBe("email_hash");

    const [summary] = await db
      .select()
      .from(schema.guestSpendSummary)
      .where(eq(schema.guestSpendSummary.guestId, ctx.guestId));
    expect(summary?.orderCount).toBe(1);
    expect(Number(summary?.totalSpendMinor)).toBe(5000);
    expect(summary?.avgSpendMinor).toBe(5000);
    expect(summary?.organisationId).toBe(ctx.orgId);
  });
});

describe("POS ingest — card guard in the pipeline", () => {
  it("strips a card-number-shaped payment label before persistence", async () => {
    const res = await ingestOrder({
      connectionId: ctx.connId,
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      lineItemsEnabled: false,
      groupCrmEnabled: false,
      order: order({ externalOrderId: `card-${run}`, paymentMethodLabel: "4242424242424242" }),
    });
    expect(res.scrubbedFields).toContain("paymentMethodLabel");
    const [row] = await db
      .select({ label: schema.posOrders.paymentMethodLabel })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.id, res.orderId));
    expect(row?.label).toBeNull();
  });
});

describe("POS ingest — booking-link match", () => {
  it("adopts the booking's guest when the check settles in its window", async () => {
    // A booking for bookingGuest at 20:00–22:00; order closes at 21:30.
    await db.insert(schema.bookings).values({
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      serviceId: ctx.serviceId,
      areaId: ctx.areaId,
      guestId: ctx.bookingGuestId,
      partySize: 4,
      startAt: new Date("2026-06-01T20:00:00Z"),
      endAt: new Date("2026-06-01T22:00:00Z"),
      status: "finished",
      source: "host",
    });

    const res = await ingestOrder({
      connectionId: ctx.connId,
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      lineItemsEnabled: false,
      groupCrmEnabled: false,
      // No email → forces the booking path. Closes inside the window.
      order: order({
        externalOrderId: `booking-${run}`,
        closedAt: new Date("2026-06-01T21:30:00Z"),
        totalMinor: 8000,
      }),
    });
    expect(res.matchMethod).toBe("booking");
    expect(res.guestId).toBe(ctx.bookingGuestId);
  });
});

describe("POS ingest — idempotency + rebuild", () => {
  it("re-ingesting the same order updates one row, no double count", async () => {
    const ext = `idem-${run}`;
    await ingestOrder({
      connectionId: ctx.connId,
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      lineItemsEnabled: false,
      groupCrmEnabled: false,
      order: order({ externalOrderId: ext, customerEmail: EMAIL, totalMinor: 1000 }),
    });
    // Replay with a corrected total — same external id.
    await ingestOrder({
      connectionId: ctx.connId,
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      lineItemsEnabled: false,
      groupCrmEnabled: false,
      order: order({ externalOrderId: ext, customerEmail: EMAIL, totalMinor: 1500 }),
    });

    const rows = await db
      .select({ id: schema.posOrders.id, total: schema.posOrders.totalMinor })
      .from(schema.posOrders)
      .where(
        and(
          eq(schema.posOrders.connectionId, ctx.connId),
          eq(schema.posOrders.externalOrderId, ext),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total).toBe(1500);
  });

  it("guest_spend_summary is rebuildable from pos_orders alone", async () => {
    // Compute the email-guest's expected aggregate straight from pos_orders.
    const orders = await db
      .select({ total: schema.posOrders.totalMinor })
      .from(schema.posOrders)
      .where(eq(schema.posOrders.guestId, ctx.guestId));
    const expectedCount = orders.length;
    const expectedTotal = orders.reduce((s, o) => s + o.total, 0);

    // Wipe + rebuild the whole org's summaries from orders.
    await db
      .delete(schema.guestSpendSummary)
      .where(eq(schema.guestSpendSummary.organisationId, ctx.orgId));
    const rebuilt = await rebuildGuestSpendForOrg(ctx.orgId);
    expect(rebuilt).toBeGreaterThanOrEqual(1);

    const [summary] = await db
      .select()
      .from(schema.guestSpendSummary)
      .where(eq(schema.guestSpendSummary.guestId, ctx.guestId));
    expect(summary?.orderCount).toBe(expectedCount);
    expect(Number(summary?.totalSpendMinor)).toBe(expectedTotal);
  });
});
