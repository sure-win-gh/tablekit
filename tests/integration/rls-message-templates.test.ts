// Integration tests for the message_templates table (Phase 2c content
// overrides).
//
// Covers:
//   1. Cross-tenant RLS — user A never sees org B's override rows.
//   2. No INSERT/UPDATE policies for authenticated.
//   3. enforce_message_templates_org_id trigger — a spoofed
//      organisation_id is corrected to the parent venue's org.
//   4. CHECK constraints — bad channel / template reject.
//   5. Idempotency unique key on (venue_id, template, channel).

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
  rowAId: string;
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

  const userAId = await mkUser(`mt-a-${run}@tablekit.test`);
  const userBId = await mkUser(`mt-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `MT-A ${run}`, slug: `mt-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `MT-B ${run}`, slug: `mt-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const mkVenue = async (orgId: string) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "cafe" })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgA.id);
  const venueBId = await mkVenue(orgB.id);

  const [rowA] = await db
    .insert(schema.messageTemplates)
    .values({
      organisationId: orgA.id,
      venueId: venueAId,
      template: "booking.confirmation",
      channel: "email",
      bodyOverride: "Hi {{guestFirstName}}",
    })
    .returning({ id: schema.messageTemplates.id });
  await db.insert(schema.messageTemplates).values({
    organisationId: orgB.id,
    venueId: venueBId,
    template: "booking.confirmation",
    channel: "email",
    bodyOverride: "B copy",
  });

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId,
    venueBId,
    rowAId: rowA!.id,
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

describe("message_templates — cross-tenant RLS", () => {
  it("user A sees only their own org's overrides", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.messageTemplates));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("authenticated cannot insert directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.messageTemplates).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          template: "booking.cancelled",
          channel: "email",
          bodyOverride: "x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated UPDATE silently affects zero rows", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.messageTemplates)
        .set({ bodyOverride: "hacked" })
        .where(eq(schema.messageTemplates.id, ctx.rowAId)),
    );
    const [row] = await db
      .select({ bodyOverride: schema.messageTemplates.bodyOverride })
      .from(schema.messageTemplates)
      .where(eq(schema.messageTemplates.id, ctx.rowAId));
    expect(row?.bodyOverride).toBe("Hi {{guestFirstName}}");
  });
});

describe("enforce_message_templates_org_id trigger", () => {
  it("rewrites a spoofed organisation_id to match the parent venue", async () => {
    const [row] = await db
      .insert(schema.messageTemplates)
      .values({
        organisationId: ctx.orgBId, // spoof
        venueId: ctx.venueAId,
        template: "booking.thank_you",
        channel: "email",
        bodyOverride: "x",
      })
      .returning({
        id: schema.messageTemplates.id,
        organisationId: schema.messageTemplates.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);
    await db.delete(schema.messageTemplates).where(eq(schema.messageTemplates.id, row!.id));
  });
});

describe("CHECK constraints + idempotency", () => {
  it("rejects an unknown channel", async () => {
    await expect(
      db.insert(schema.messageTemplates).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        template: "booking.confirmation",
        channel: "carrier-pigeon",
        bodyOverride: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown template", async () => {
    await expect(
      db.insert(schema.messageTemplates).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        template: "booking.bogus",
        channel: "email",
        bodyOverride: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate (venue_id, template, channel)", async () => {
    await expect(
      db.insert(schema.messageTemplates).values({
        organisationId: ctx.orgAId,
        venueId: ctx.venueAId,
        template: "booking.confirmation",
        channel: "email",
        bodyOverride: "dupe",
      }),
    ).rejects.toThrow();
  });
});
