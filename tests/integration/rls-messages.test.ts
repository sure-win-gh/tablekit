// Integration tests for the messaging phase schema.
//
// Covers:
//   1. Cross-tenant RLS on messages — user A never sees org B's rows.
//   2. No INSERT/UPDATE/DELETE policies for authenticated.
//   3. enforce_messages_org_id trigger — spoofed organisation_id is
//      silently corrected to the parent booking's org.
//   4. CHECK constraints — bad channel / template / status reject;
//      negative attempts reject.
//   5. Idempotency unique key on (booking_id, template, channel).

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
  bookingAId: string;
  bookingBId: string;
  messageAId: string;
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

  const userAId = await mkUser(`msg-a-${run}@tablekit.test`);
  const userBId = await mkUser(`msg-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `M-A ${run}`, slug: `msg-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `M-B ${run}`, slug: `msg-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  // Minimum fixture chain for valid booking_ids.
  const mkBooking = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "cafe" })
      .returning({ id: schema.venues.id });
    const [a] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId: v!.id, name: "Inside" })
      .returning({ id: schema.areas.id });
    const [s] = await db
      .insert(schema.services)
      .values({
        organisationId: orgId,
        venueId: v!.id,
        name: "Open",
        schedule: { days: ["mon"], start: "08:00", end: "17:00" },
        turnMinutes: 60,
      })
      .returning({ id: schema.services.id });
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "Test",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `mh_${orgId}_${run}`,
      })
      .returning({ id: schema.guests.id });
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: orgId,
        venueId: v!.id,
        serviceId: s!.id,
        areaId: a!.id,
        guestId: g!.id,
        partySize: 2,
        startAt: new Date("2026-09-01T12:00:00Z"),
        endAt: new Date("2026-09-01T13:00:00Z"),
        status: "confirmed",
        source: "host",
      })
      .returning({ id: schema.bookings.id });
    return b!.id;
  };

  const bookingAId = await mkBooking(orgA.id);
  const bookingBId = await mkBooking(orgB.id);

  const [msgA] = await db
    .insert(schema.messages)
    .values({
      organisationId: orgA.id,
      bookingId: bookingAId,
      channel: "email",
      template: "booking.confirmation",
    })
    .returning({ id: schema.messages.id });
  await db.insert(schema.messages).values({
    organisationId: orgB.id,
    bookingId: bookingBId,
    channel: "email",
    template: "booking.confirmation",
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    bookingAId,
    bookingBId,
    messageAId: msgA!.id,
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

describe("messages — cross-tenant RLS", () => {
  it("user A sees only their own org's rows", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.messages));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.messages).values({
          organisationId: ctx.orgAId,
          bookingId: ctx.bookingAId,
          channel: "email",
          template: "booking.cancelled",
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated UPDATE silently affects zero rows", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.messages)
        .set({ status: "sent" })
        .where(eq(schema.messages.id, ctx.messageAId)),
    );
    const [row] = await db
      .select({ status: schema.messages.status })
      .from(schema.messages)
      .where(eq(schema.messages.id, ctx.messageAId));
    expect(row?.status).toBe("queued");
  });
});

describe("enforce_messages_org_id trigger", () => {
  it("rewrites a spoofed organisation_id to match the parent booking", async () => {
    const [row] = await db
      .insert(schema.messages)
      .values({
        organisationId: ctx.orgBId, // spoof
        bookingId: ctx.bookingAId,
        channel: "email",
        template: "booking.thank_you",
      })
      .returning({ id: schema.messages.id, organisationId: schema.messages.organisationId });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.messages).where(eq(schema.messages.id, row!.id));
  });
});

describe("CHECK constraints", () => {
  it("rejects an unknown channel", async () => {
    await expect(
      db.insert(schema.messages).values({
        organisationId: ctx.orgAId,
        bookingId: ctx.bookingAId,
        channel: "carrier-pigeon",
        template: "booking.confirmation",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown template", async () => {
    await expect(
      db.insert(schema.messages).values({
        organisationId: ctx.orgAId,
        bookingId: ctx.bookingAId,
        channel: "email",
        template: "booking.bogus",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown status", async () => {
    await expect(
      db.insert(schema.messages).values({
        organisationId: ctx.orgAId,
        bookingId: ctx.bookingAId,
        channel: "email",
        template: "booking.reminder_24h",
        status: "haunted",
      }),
    ).rejects.toThrow();
  });

  it("rejects negative attempts", async () => {
    await expect(
      db.insert(schema.messages).values({
        organisationId: ctx.orgAId,
        bookingId: ctx.bookingAId,
        channel: "email",
        template: "booking.reminder_2h",
        attempts: -1,
      }),
    ).rejects.toThrow();
  });
});

describe("idempotency unique key", () => {
  it("rejects a second row with the same (booking_id, template, channel)", async () => {
    // The fixture already inserted (bookingAId, 'booking.confirmation', 'email').
    await expect(
      db.insert(schema.messages).values({
        organisationId: ctx.orgAId,
        bookingId: ctx.bookingAId,
        channel: "email",
        template: "booking.confirmation",
      }),
    ).rejects.toThrow();
  });
});
