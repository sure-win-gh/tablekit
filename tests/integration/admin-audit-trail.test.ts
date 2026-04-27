// Integration tests for the platform admin audit trail.
//
// Asserts two things:
//   1. platformAudit.log() persists a row through adminDb().
//   2. RLS deny-all on platform_audit_log holds: an authenticated
//      operator-role user CANNOT read these rows, even one tied to
//      their own org context (the table has no organisation_id, but
//      the policy denies regardless).

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";

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
const ACTOR = `admin-${run}@tablekit.test`;

let userId: string;
let writtenRowId: string;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `audit-trail-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  userId = data.user.id;
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  if (writtenRowId) {
    await db.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.id, writtenRowId));
  }
  await pool.end();
});

describe("platform audit trail", () => {
  it("platformAudit.log() persists a row via adminDb", async () => {
    await platformAudit.log({
      actorEmail: ACTOR,
      action: "login",
      metadata: { test: run },
    });

    const rows = await db
      .select()
      .from(schema.platformAuditLog)
      .where(eq(schema.platformAuditLog.actorEmail, ACTOR));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("login");
    expect(rows[0]?.metadata).toEqual({ test: run });
    writtenRowId = rows[0]!.id;
  });

  it("authenticated operator cannot read platform_audit_log — RLS deny-all", async () => {
    // Same row exists in the table (written above). Under RLS as a
    // regular authenticated user the deny-all policy should hide it
    // entirely — zero rows visible regardless of WHERE clause.
    const visible = await asUser(userId, (tx) =>
      tx
        .select()
        .from(schema.platformAuditLog)
        .where(eq(schema.platformAuditLog.actorEmail, ACTOR)),
    );
    expect(visible).toEqual([]);

    const all = await asUser(userId, (tx) => tx.select().from(schema.platformAuditLog));
    expect(all).toEqual([]);
  });

  it("authenticated operator cannot insert into platform_audit_log — RLS deny-all", async () => {
    await expect(
      asUser(userId, (tx) =>
        tx.insert(schema.platformAuditLog).values({
          actorEmail: `imposter-${run}@example.com`,
          action: "login",
        }),
      ),
    ).rejects.toThrow();
  });
});
