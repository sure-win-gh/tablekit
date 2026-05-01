// Integration test for the import_jobs table.
//
// Mirrors rls-dsar.test.ts. Seeds an import_jobs row under each org
// via the superuser pool, then drives queries as each user under the
// `authenticated` role and asserts:
//
//   1. user A reads only org A's job (cross-tenant isolation)
//   2. authenticated INSERT is denied (writes flow via adminDb)
//   3. authenticated UPDATE is silently ignored
//
// If this passes, the table's RLS posture matches the rest of the
// org-scoped tables and the import-job runner (in a later PR) can
// rely on adminDb() for writes.

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
  jobAId: string;
  jobBId: string;
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

  const userAId = await mkUser(`imp-a-${run}@tablekit.test`);
  const userBId = await mkUser(`imp-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Imp-A ${run}`, slug: `imp-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Imp-B ${run}`, slug: `imp-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  const [jobA] = await db
    .insert(schema.importJobs)
    .values({
      organisationId: orgA.id,
      actorUserId: userAId,
      source: "generic-csv",
      filename: "guests-a.csv",
    })
    .returning({ id: schema.importJobs.id });
  const [jobB] = await db
    .insert(schema.importJobs)
    .values({
      organisationId: orgB.id,
      actorUserId: userBId,
      source: "opentable",
      filename: "guests-b.csv",
    })
    .returning({ id: schema.importJobs.id });
  if (!jobA || !jobB) throw new Error("import_jobs insert returned no row");

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    jobAId: jobA.id,
    jobBId: jobB.id,
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

describe("import_jobs — RLS isolation", () => {
  it("user A reads only their own org's import jobs", async () => {
    const rows = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ id: schema.importJobs.id, orgId: schema.importJobs.organisationId })
        .from(schema.importJobs),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.jobAId);
    expect(ids).not.toContain(ctx.jobBId);
  });

  it("user B reads only their own org's import jobs", async () => {
    const rows = await asUser(ctx.userBId, (tx) =>
      tx
        .select({ id: schema.importJobs.id, orgId: schema.importJobs.organisationId })
        .from(schema.importJobs),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.jobBId);
    expect(ids).not.toContain(ctx.jobAId);
  });

  it("authenticated role cannot insert into their own org (no INSERT policy)", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.importJobs).values({
          organisationId: ctx.orgAId,
          source: "generic-csv",
          filename: "should-not-land.csv",
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated role cannot insert targeting another org (cross-org hijack)", async () => {
    // The more interesting attacker shape: user A, authenticated,
    // tries to insert a row claiming to be in org B. Today this is
    // blocked by the absence of an INSERT policy at all; this test
    // pins the behaviour so a future "members can insert" policy
    // must explicitly carry a WITH CHECK on organisation_id.
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx.insert(schema.importJobs).values({
          organisationId: ctx.orgBId,
          source: "generic-csv",
          filename: "cross-org-hijack.csv",
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated role cannot update their own org's job (no UPDATE policy)", async () => {
    // No UPDATE policy → the WHERE matches zero rows for the
    // authenticated role. Re-read via the superuser pool and confirm
    // the filename is unchanged.
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.importJobs)
        .set({ filename: "HIJACKED" })
        .where(eq(schema.importJobs.id, ctx.jobAId)),
    );
    const [row] = await db
      .select({ filename: schema.importJobs.filename })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, ctx.jobAId));
    expect(row?.filename).toBe("guests-a.csv");
  });

  it("authenticated role cannot update another org's job (cross-org hijack)", async () => {
    // User A tries to mutate org B's row. The same SET-LOCAL trick
    // that powers RLS is what stops this — and we verify by reading
    // org B's row back via the superuser pool.
    await asUser(ctx.userAId, (tx) =>
      tx
        .update(schema.importJobs)
        .set({ filename: "HIJACKED" })
        .where(eq(schema.importJobs.id, ctx.jobBId)),
    );
    const [row] = await db
      .select({ filename: schema.importJobs.filename })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, ctx.jobBId));
    expect(row?.filename).toBe("guests-b.csv");
  });

  it("authenticated role cannot delete an import job (no DELETE policy)", async () => {
    // Symmetry with the UPDATE check: deleting their own org's row
    // must also fail silently. Re-read via the superuser pool and
    // confirm both rows still exist.
    await asUser(ctx.userAId, (tx) =>
      tx.delete(schema.importJobs).where(eq(schema.importJobs.id, ctx.jobAId)),
    );
    const [row] = await db
      .select({ id: schema.importJobs.id })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, ctx.jobAId));
    expect(row?.id).toBe(ctx.jobAId);
  });
});
