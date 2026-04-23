// The load-bearing test.
//
// Creates two organisations (A and B) with one user each, then drives
// queries as each user and asserts RLS makes data from the *other*
// org invisible. Every future tenant-scoped table copies this pattern
// — if this passes for a new table, that table is safe to ship.
//
// Uses the same SET LOCAL dance lib/db/client.ts:withUser does so the
// test exercises the real RLS policies as the `authenticated` role.
// The Supabase Auth API is used to create users (so auth.users exists
// and the public.users trigger fires); adminDb handles org/membership
// inserts (which RLS denies to authenticated by design).

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Mirror of withUser's transaction dance, but inlined so the test
// doesn't depend on cookies() (which only works inside a Next request
// context).
async function asUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'authenticated', true)`);
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    return fn(tx as Db);
  });
}

type Ctx = {
  userAId: string;
  userBId: string;
  orgAId: string;
  orgBId: string;
};

// Use a timestamped suffix so repeat runs don't collide on email.
const run = Date.now().toString(36);
const emailA = `test-a-${run}@tablekit.test`;
const emailB = `test-b-${run}@tablekit.test`;
const PASSWORD = "integration-test-pw-1234";

let ctx: Ctx;

beforeAll(async () => {
  const { data: a, error: ea } = await admin.auth.admin.createUser({
    email: emailA,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "User A" },
  });
  if (ea || !a.user) throw ea ?? new Error("createUser A failed");

  const { data: b, error: eb } = await admin.auth.admin.createUser({
    email: emailB,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "User B" },
  });
  if (eb || !b.user) throw eb ?? new Error("createUser B failed");

  const userAId = a.user.id;
  const userBId = b.user.id;

  // Create orgs and memberships via the module-level `db` (runs as
  // postgres superuser, bypassing RLS — same shape as adminDb).
  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Org A ${run}`, slug: `org-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Org B ${run}`, slug: `org-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  // One audit entry per org so audit_log RLS has rows to filter.
  await audit.log({
    organisationId: orgA.id,
    actorUserId: userAId,
    action: "signup",
    targetType: "user",
    targetId: userAId,
  });
  await audit.log({
    organisationId: orgB.id,
    actorUserId: userBId,
    action: "signup",
    targetType: "user",
    targetId: userBId,
  });

  ctx = { userAId, userBId, orgAId: orgA.id, orgBId: orgB.id };
});

afterAll(async () => {
  if (ctx) {
    // Deleting the auth.users rows cascades through our schema via the
    // FKs: public.users → memberships → (and org FK'd cascades out).
    // Organisations aren't cascaded from users, so clean explicitly.
    await admin.auth.admin.deleteUser(ctx.userAId).catch(() => undefined);
    await admin.auth.admin.deleteUser(ctx.userBId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("RLS cross-tenant isolation", () => {
  it("user A reads their own org and not org B", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.organisations));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.orgAId);
    expect(ids).not.toContain(ctx.orgBId);
  });

  it("user B reads their own org and not org A", async () => {
    const rows = await asUser(ctx.userBId, (tx) => tx.select().from(schema.organisations));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.orgBId);
    expect(ids).not.toContain(ctx.orgAId);
  });

  it("user A sees only their own membership, not user B's", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.memberships));
    const userIds = rows.map((r) => r.userId);
    expect(userIds).toContain(ctx.userAId);
    expect(userIds).not.toContain(ctx.userBId);
  });

  it("user A sees only their own audit entries, not org B's", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.auditLog));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(ctx.orgAId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });

  it("user A sees their own user row and not user B's", async () => {
    const rows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.users));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.userAId);
    expect(ids).not.toContain(ctx.userBId);
  });

  it("user A cannot update user B's row", async () => {
    // RLS on UPDATE: policy requires id = auth.uid(). With WITH CHECK
    // and USING both scoping to self, the update affects zero rows
    // silently — we assert by re-reading via admin and checking that
    // user B's full_name is unchanged.
    await asUser(ctx.userAId, (tx) =>
      tx.update(schema.users).set({ fullName: "HIJACKED" }).where(eq(schema.users.id, ctx.userBId)),
    );

    const rows = await db
      .select({ fullName: schema.users.fullName })
      .from(schema.users)
      .where(eq(schema.users.id, ctx.userBId));
    expect(rows[0]?.fullName).toBe("User B");
  });

  it("authenticated role cannot insert an audit_log entry directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.auditLog).values({
          organisationId: ctx.orgAId,
          action: "signup",
        }),
      ),
    ).rejects.toThrow();
  });
});
