// Integration tests for the payments-deposits phase (Phase 1 schema).
//
// Covers:
//   1. Cross-tenant RLS on deposit_rules + payments — user A never
//      sees org B's rows.
//   2. No INSERT/UPDATE/DELETE policies for authenticated — direct
//      writes from a user-context session fail (insert throws, update
//      silently zero-rows).
//   3. enforce_{deposit_rules,payments}_org_id triggers — an insert
//      with the "wrong" organisation_id is silently corrected to the
//      parent's org_id. Mirrors the areas/tables/services pattern from
//      the 0001 venues migration.
//   4. CHECK constraints — invalid kind / negative non-refund amount /
//      non-GBP currency / deposit_rules party-range all reject.

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

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

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  bookingAId: string;
  bookingBId: string;
  ruleAId: string;
  ruleBId: string;
  paymentAId: string;
  paymentBId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const mkUser = async (email: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "integration-test-pw-1234",
      email_confirm: true,
      user_metadata: { full_name: email },
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    return data.user.id;
  };

  const userAId = await mkUser(`dep-a-${run}@tablekit.test`);
  const userBId = await mkUser(`dep-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `D-A ${run}`, slug: `dep-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `D-B ${run}`, slug: `dep-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string, label: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({
        organisationId: orgId,
        name: label,
        venueType: "cafe",
        timezone: "Europe/London",
      })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgA.id, "VA");
  const venueBId = await mkVenue(orgB.id, "VB");

  // Minimal booking fixtures — we only need valid booking_ids for the
  // payments FK. Bookings require area + service + guest via FKs, so
  // set those up too.
  const mkArea = async (orgId: string, venueId: string) => {
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId, name: "Inside" })
      .returning({ id: schema.areas.id });
    return a!.id;
  };
  const areaAId = await mkArea(orgA.id, venueAId);
  const areaBId = await mkArea(orgB.id, venueBId);

  const schedule = {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "08:00",
    end: "17:00",
  };
  const mkService = async (orgId: string, venueId: string) => {
    const [s] = await db
      .insert(schema.services)
      .values({ organisationId: orgId, venueId, name: "Open", schedule, turnMinutes: 60 })
      .returning({ id: schema.services.id });
    return s!.id;
  };
  const serviceAId = await mkService(orgA.id, venueAId);
  const serviceBId = await mkService(orgB.id, venueBId);

  // Guests have encrypted PII; for a test fixture we stash placeholder
  // ciphertext — no code path here decrypts it. email_hash must be
  // unique per org.
  const mkGuest = async (orgId: string) => {
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "Test",
        lastNameCipher: "cipher",
        emailCipher: "cipher",
        emailHash: `hash_${orgId}_${run}`,
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };
  const guestAId = await mkGuest(orgA.id);
  const guestBId = await mkGuest(orgB.id);

  const mkBooking = async (
    orgId: string,
    venueId: string,
    serviceId: string,
    areaId: string,
    guestId: string,
  ) => {
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: orgId,
        venueId,
        serviceId,
        areaId,
        guestId,
        partySize: 2,
        // Fixed future time; test isn't exercising availability.
        startAt: new Date("2026-05-10T12:00:00Z"),
        endAt: new Date("2026-05-10T13:00:00Z"),
        status: "requested",
        source: "host",
      })
      .returning({ id: schema.bookings.id });
    return b!.id;
  };
  const bookingAId = await mkBooking(orgA.id, venueAId, serviceAId, areaAId, guestAId);
  const bookingBId = await mkBooking(orgB.id, venueBId, serviceBId, areaBId, guestBId);

  const [ruleA] = await db
    .insert(schema.depositRules)
    .values({
      organisationId: orgA.id,
      venueId: venueAId,
      kind: "flat",
      amountMinor: 2000,
    })
    .returning({ id: schema.depositRules.id });
  const [ruleB] = await db
    .insert(schema.depositRules)
    .values({
      organisationId: orgB.id,
      venueId: venueBId,
      kind: "flat",
      amountMinor: 2000,
    })
    .returning({ id: schema.depositRules.id });

  const [payA] = await db
    .insert(schema.payments)
    .values({
      organisationId: orgA.id,
      bookingId: bookingAId,
      kind: "deposit",
      stripeIntentId: `pi_test_a_${run}`,
      amountMinor: 2000,
      currency: "GBP",
      status: "succeeded",
    })
    .returning({ id: schema.payments.id });
  const [payB] = await db
    .insert(schema.payments)
    .values({
      organisationId: orgB.id,
      bookingId: bookingBId,
      kind: "deposit",
      stripeIntentId: `pi_test_b_${run}`,
      amountMinor: 2000,
      currency: "GBP",
      status: "succeeded",
    })
    .returning({ id: schema.payments.id });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
    bookingAId,
    bookingBId,
    ruleAId: ruleA!.id,
    ruleBId: ruleB!.id,
    paymentAId: payA!.id,
    paymentBId: payB!.id,
  };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("deposit_rules — cross-tenant RLS", () => {
  it("user A sees only their own org's rules", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.depositRules));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert a deposit_rule directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.depositRules).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          kind: "flat",
          amountMinor: 500,
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated UPDATE silently affects zero rows (no UPDATE policy)", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.depositRules)
        .set({ amountMinor: 9999 })
        .where(eq(schema.depositRules.id, ctx.ruleAId)),
    );
    const [row] = await db
      .select({ amountMinor: schema.depositRules.amountMinor })
      .from(schema.depositRules)
      .where(eq(schema.depositRules.id, ctx.ruleAId));
    expect(row?.amountMinor).toBe(2000);
  });
});

describe("payments — cross-tenant RLS", () => {
  it("user A sees only their own org's payment rows", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.payments));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert a payment directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.payments).values({
          organisationId: ctx.orgAId,
          bookingId: ctx.bookingAId,
          kind: "deposit",
          stripeIntentId: `pi_hijack_${run}`,
          amountMinor: 100,
          currency: "GBP",
          status: "succeeded",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("enforce_*_org_id triggers", () => {
  it("deposit_rules trigger rewrites a spoofed organisation_id to match the parent venue", async () => {
    const [row] = await db
      .insert(schema.depositRules)
      .values({
        // Intentional spoof — the trigger should overwrite with orgA.
        organisationId: ctx.orgBId,
        venueId: ctx.venueAId,
        kind: "per_cover",
        amountMinor: 500,
      })
      .returning({
        id: schema.depositRules.id,
        organisationId: schema.depositRules.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.depositRules).where(eq(schema.depositRules.id, row!.id));
  });

  it("payments trigger rewrites a spoofed organisation_id to match the parent booking", async () => {
    const [row] = await db
      .insert(schema.payments)
      .values({
        // Spoof — trigger should reset to orgA based on bookingA.
        organisationId: ctx.orgBId,
        bookingId: ctx.bookingAId,
        kind: "deposit",
        stripeIntentId: `pi_trigger_${run}`,
        amountMinor: 500,
        currency: "GBP",
        status: "pending_creation",
      })
      .returning({ id: schema.payments.id, organisationId: schema.payments.organisationId });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.payments).where(eq(schema.payments.id, row!.id));
  });
});

describe("CHECK constraints", () => {
  it("rejects an unknown deposit_rules.kind", async () => {
    await expect(
      db.insert(schema.depositRules).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        kind: "bogus",
        amountMinor: 100,
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-GBP currency on deposit_rules", async () => {
    await expect(
      db.insert(schema.depositRules).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        kind: "flat",
        amountMinor: 100,
        currency: "USD",
      }),
    ).rejects.toThrow();
  });

  it("rejects a negative amount on a non-refund payment", async () => {
    await expect(
      db.insert(schema.payments).values({
        organisationId: ctx.orgAId,
        bookingId: ctx.bookingAId,
        kind: "deposit",
        stripeIntentId: `pi_neg_${run}`,
        amountMinor: -1,
        currency: "GBP",
        status: "succeeded",
      }),
    ).rejects.toThrow();
  });

  it("accepts a negative amount on a refund payment", async () => {
    const [row] = await db
      .insert(schema.payments)
      .values({
        organisationId: ctx.orgAId,
        bookingId: ctx.bookingAId,
        kind: "refund",
        stripeIntentId: `re_ok_${run}`,
        amountMinor: -500,
        currency: "GBP",
        status: "pending_creation",
      })
      .returning({ id: schema.payments.id });
    expect(row?.id).toBeDefined();
    await db.delete(schema.payments).where(eq(schema.payments.id, row!.id));
  });

  it("rejects a deposit_rules row with max_party < min_party", async () => {
    await expect(
      db.insert(schema.depositRules).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        kind: "flat",
        amountMinor: 100,
        minParty: 5,
        maxParty: 2,
      }),
    ).rejects.toThrow();
  });
});
