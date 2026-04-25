// Integration tests for the waitlist phase schema.
//
// Covers:
//   1. Cross-tenant RLS on waitlists — user A never sees org B.
//   2. No INSERT/UPDATE/DELETE policies for authenticated.
//   3. enforce_waitlists_org_id trigger.
//   4. CHECK constraints on status + party_size.
//   5. bookings.source widened — 'walk-in' is now valid.

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
  serviceAId: string;
  guestAId: string;
  guestBId: string;
  waitlistAId: string;
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

  const userAId = await mkUser(`wl-a-${run}@tablekit.test`);
  const userBId = await mkUser(`wl-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `W-A ${run}`, slug: `wl-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `W-B ${run}`, slug: `wl-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert failed");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string, label: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: label, venueType: "cafe" })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgA.id, "VA");
  const venueBId = await mkVenue(orgB.id, "VB");

  const [svcA] = await db
    .insert(schema.services)
    .values({
      organisationId: orgA.id,
      venueId: venueAId,
      name: "Open",
      schedule: { days: ["mon"], start: "08:00", end: "17:00" },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });

  const mkGuest = async (orgId: string, suffix: string) => {
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "Walk",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `wlh_${orgId}_${suffix}_${run}`,
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };
  const guestAId = await mkGuest(orgA.id, "a");
  const guestBId = await mkGuest(orgB.id, "b");

  const [waitlistA] = await db
    .insert(schema.waitlists)
    .values({
      organisationId: orgA.id,
      venueId: venueAId,
      guestId: guestAId,
      partySize: 2,
    })
    .returning({ id: schema.waitlists.id });
  await db.insert(schema.waitlists).values({
    organisationId: orgB.id,
    venueId: venueBId,
    guestId: guestBId,
    partySize: 4,
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
    serviceAId: svcA!.id,
    guestAId,
    guestBId,
    waitlistAId: waitlistA!.id,
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

describe("waitlists — cross-tenant RLS", () => {
  it("user A sees only their org's rows", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.waitlists));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.waitlists).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          guestId: ctx.guestAId,
          partySize: 2,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("enforce_waitlists_org_id trigger", () => {
  it("rewrites a spoofed organisation_id from the parent venue", async () => {
    const [row] = await db
      .insert(schema.waitlists)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: ctx.venueAId,
        guestId: ctx.guestAId,
        partySize: 2,
      })
      .returning({ id: schema.waitlists.id, organisationId: schema.waitlists.organisationId });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.waitlists).where(eq(schema.waitlists.id, row!.id));
  });
});

describe("CHECK constraints", () => {
  it("rejects an unknown status", async () => {
    await expect(
      db.insert(schema.waitlists).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        guestId: ctx.guestAId,
        partySize: 2,
        status: "vibing",
      }),
    ).rejects.toThrow();
  });

  it("rejects party_size outside 1-50", async () => {
    await expect(
      db.insert(schema.waitlists).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        guestId: ctx.guestAId,
        partySize: 0,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.waitlists).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        guestId: ctx.guestAId,
        partySize: 100,
      }),
    ).rejects.toThrow();
  });
});

describe("bookings.source — 'walk-in' admitted after 0010", () => {
  it("allows source='walk-in' (and rejects an invalid source as before)", async () => {
    // Create the booking-fixture chain on org A.
    const [area] = await db
      .insert(schema.areas)
      .values({ organisationId: ctx.orgAId, venueId: ctx.venueAId, name: "Inside" })
      .returning({ id: schema.areas.id });

    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        serviceId: ctx.serviceAId,
        areaId: area!.id,
        guestId: ctx.guestAId,
        partySize: 2,
        startAt: new Date("2026-10-01T19:00:00Z"),
        endAt: new Date("2026-10-01T20:00:00Z"),
        status: "seated",
        source: "walk-in",
      })
      .returning({ id: schema.bookings.id, source: schema.bookings.source });
    expect(b?.source).toBe("walk-in");

    await expect(
      db.insert(schema.bookings).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        serviceId: ctx.serviceAId,
        areaId: area!.id,
        guestId: ctx.guestAId,
        partySize: 2,
        startAt: new Date("2026-10-01T20:00:00Z"),
        endAt: new Date("2026-10-01T21:00:00Z"),
        status: "seated",
        source: "test",
      }),
    ).rejects.toThrow();

    await db.delete(schema.bookings).where(eq(schema.bookings.id, b!.id));
  });
});
