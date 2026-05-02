// Integration test for the enquiries table.
//
// Mirrors rls-import-jobs.test.ts. Seeds an enquiries row under each
// org via the superuser pool, then drives queries as each user under
// the `authenticated` role and asserts:
//
//   1. user A reads only org A's enquiry (cross-tenant isolation)
//   2. authenticated INSERT is denied (writes flow via adminDb)
//   3. authenticated UPDATE is silently no-op (no UPDATE policy)
//   4. authenticated DELETE is silently no-op (no DELETE policy)
//   5. The enforce_enquiries_org_id trigger overrides a mismatched
//      organisation_id at insert time with the venue's true org.

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
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
  enquiryAId: string;
  enquiryBId: string;
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

  const userAId = await mkUser(`enq-a-${run}@tablekit.test`);
  const userBId = await mkUser(`enq-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Enq-A ${run}`, slug: `enq-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Enq-B ${run}`, slug: `enq-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  // Each org needs a venue (enquiries.venue_id FK).
  const [venueA] = await db
    .insert(schema.venues)
    .values({ organisationId: orgA.id, name: "Venue A", venueType: "restaurant" })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({ organisationId: orgB.id, name: "Venue B", venueType: "restaurant" })
    .returning({ id: schema.venues.id });
  if (!venueA || !venueB) throw new Error("venue insert returned no row");

  // Seed one enquiry per org. Cipher fields take placeholder values
  // (not real ciphertext) — these tests don't decrypt.
  const [enqA] = await db
    .insert(schema.enquiries)
    .values({
      organisationId: orgA.id,
      venueId: venueA.id,
      fromEmailHash: "h-a",
      fromEmailCipher: "c-a",
      subjectCipher: "s-a",
      bodyCipher: "b-a",
    })
    .returning({ id: schema.enquiries.id });
  const [enqB] = await db
    .insert(schema.enquiries)
    .values({
      organisationId: orgB.id,
      venueId: venueB.id,
      fromEmailHash: "h-b",
      fromEmailCipher: "c-b",
      subjectCipher: "s-b",
      bodyCipher: "b-b",
    })
    .returning({ id: schema.enquiries.id });
  if (!enqA || !enqB) throw new Error("enquiries insert returned no row");

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    venueAId: venueA.id,
    venueBId: venueB.id,
    enquiryAId: enqA.id,
    enquiryBId: enqB.id,
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

describe("enquiries — RLS isolation", () => {
  it("user A reads only their own org's enquiries", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ id: schema.enquiries.id, orgId: schema.enquiries.organisationId })
        .from(schema.enquiries),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.enquiryAId);
    expect(ids).not.toContain(ctx.enquiryBId);
  });

  it("user B reads only their own org's enquiries", async () => {
    const rows = await asUser(ctx.userBId, (tx) =>
      tx
        .select({ id: schema.enquiries.id, orgId: schema.enquiries.organisationId })
        .from(schema.enquiries),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.enquiryBId);
    expect(ids).not.toContain(ctx.enquiryAId);
  });

  it("authenticated role cannot insert (no INSERT policy)", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.enquiries).values({
          organisationId: ctx.orgAId,
          venueId: ctx.venueAId,
          fromEmailHash: "h-x",
          fromEmailCipher: "c-x",
          subjectCipher: "s-x",
          bodyCipher: "b-x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated role cannot update an enquiry (no UPDATE policy)", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.enquiries)
        .set({ subjectCipher: "HIJACKED" })
        .where(eq(schema.enquiries.id, ctx.enquiryAId)),
    );
    const [row] = await db
      .select({ subjectCipher: schema.enquiries.subjectCipher })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, ctx.enquiryAId));
    expect(row?.subjectCipher).toBe("s-a");
  });

  it("authenticated role cannot delete an enquiry (no DELETE policy)", async () => {
    await asUser(ctx.userAId, (tx) =>
      tx.delete(schema.enquiries).where(eq(schema.enquiries.id, ctx.enquiryAId)),
    );
    const [row] = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.id, ctx.enquiryAId));
    expect(row?.id).toBe(ctx.enquiryAId);
  });
});

describe("enquiries — enforce_enquiries_org_id trigger", () => {
  it("overrides a mismatched organisation_id with the parent venue's true org", async () => {
    // Caller passes org B's id but venue A's id. The trigger should
    // overwrite organisation_id to match venue A's parent (org A).
    const [row] = await db
      .insert(schema.enquiries)
      .values({
        organisationId: ctx.orgBId, // wrong — trigger overrides
        venueId: ctx.venueAId,
        fromEmailHash: "h-trigger",
        fromEmailCipher: "c",
        subjectCipher: "s",
        bodyCipher: "b",
      })
      .returning({
        id: schema.enquiries.id,
        organisationId: schema.enquiries.organisationId,
      });
    expect(row?.organisationId).toBe(ctx.orgAId);

    // Cleanup — the trigger may have stamped a different org, so
    // delete by the row id we just got back.
    if (row) {
      await db.delete(schema.enquiries).where(eq(schema.enquiries.id, row.id));
    }
  });
});
