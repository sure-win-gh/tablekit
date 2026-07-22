// Integration tests for POS phone-hash matching + the guests.phone_hash
// backfill (migration 0050).
//
//   * upsertGuest now populates phone_hash with hashForLookup(value,"phone");
//   * an order carrying only a phone links to that guest (match_method
//     'phone_hash');
//   * backfillGuestPhoneHash fills phone_hash for legacy rows that have a
//     phone_cipher but no hash, byte-identically to a fresh hash.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { backfillGuestPhoneHash } from "@/lib/guests/backfill-phone-hash";
import { upsertGuest } from "@/lib/guests/upsert";
import { ingestOrder } from "@/lib/pos/ingest";
import type { NormalisedOrder } from "@/lib/pos/types";
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
const PHONE = "+447700900123";

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
};
let ctx: Ctx;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `pos-phone-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const ownerId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-Phone ${run}`, slug: `pos-phone-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  await db
    .insert(schema.memberships)
    .values({ userId: ownerId, organisationId: org!.id, role: "owner" });

  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org!.id,
      name: "V",
      venueType: "restaurant",
      timezone: "Europe/London",
    })
    .returning({ id: schema.venues.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: org!.id, venueId: venue!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  const [svc] = await db
    .insert(schema.services)
    .values({
      organisationId: org!.id,
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
    .values({ organisationId: org!.id, venueId: venue!.id, provider: "generic" })
    .returning({ id: schema.posConnections.id });

  const g = await upsertGuest(org!.id, ownerId, {
    firstName: "Phone",
    lastName: "Guest",
    email: `pos-phone-guest-${run}@example.com`,
    phone: PHONE,
  });
  if (!g.ok) throw new Error("guest upsert failed");

  // Realised booking so the venue-scoped (group-CRM-off) match passes.
  await db.insert(schema.bookings).values({
    organisationId: org!.id,
    venueId: venue!.id,
    serviceId: svc!.id,
    areaId: area!.id,
    guestId: g.guestId,
    partySize: 2,
    startAt: new Date("2026-05-10T18:00:00Z"),
    endAt: new Date("2026-05-10T20:00:00Z"),
    status: "finished",
    source: "host",
  });

  ctx = {
    ownerId,
    orgId: org!.id,
    venueId: venue!.id,
    serviceId: svc!.id,
    areaId: area!.id,
    connId: conn!.id,
    guestId: g.guestId,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.ownerId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("guests.phone_hash population", () => {
  it("upsertGuest stores the deterministic phone hash", async () => {
    const [g] = await db
      .select({ phoneHash: schema.guests.phoneHash })
      .from(schema.guests)
      .where(eq(schema.guests.id, ctx.guestId));
    expect(g?.phoneHash).toBe(hashForLookup(PHONE, "phone"));
  });
});

describe("POS ingest — phone-hash match", () => {
  it("links an order carrying only the guest's phone", async () => {
    const res = await ingestOrder({
      connectionId: ctx.connId,
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      lineItemsEnabled: false,
      groupCrmEnabled: false,
      order: order({ externalOrderId: `phone-${run}`, customerPhone: PHONE, totalMinor: 3300 }),
    });
    expect(res.matchMethod).toBe("phone_hash");
    expect(res.guestId).toBe(ctx.guestId);
  });
});

describe("backfillGuestPhoneHash", () => {
  it("fills phone_hash for a legacy row missing it", async () => {
    // Simulate a pre-0050 row: clear the hash while keeping phone_cipher.
    await db
      .update(schema.guests)
      .set({ phoneHash: null })
      .where(eq(schema.guests.id, ctx.guestId));

    // Scoped to this test's org: the CI database is shared and long-lived, so
    // an unrelated row with a malformed cipher would otherwise abort the sweep.
    const result = await backfillGuestPhoneHash(500, ctx.orgId);
    expect(result.updated).toBeGreaterThanOrEqual(1);

    const [g] = await db
      .select({ phoneHash: schema.guests.phoneHash })
      .from(schema.guests)
      .where(eq(schema.guests.id, ctx.guestId));
    expect(g?.phoneHash).toBe(hashForLookup(PHONE, "phone"));
  });
});
