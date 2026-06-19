// RLS test for password_reset_tokens (security audit P2 / CLAUDE.md rule 3).
// Platform-level deny-all table (same posture as outreach_claims /
// platform_audit_log): authenticated + anon can neither read nor write — all
// access goes through adminDb() from the reset server actions.

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashResetToken } from "@/lib/auth/password-reset";
import * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

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
let userId: string;
let tokenId: string;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `pwreset-rls-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  userId = data.user.id;

  // Seed a token via adminDb (bypasses RLS) so there's a row to NOT see.
  const [row] = await db
    .insert(schema.passwordResetTokens)
    .values({
      userId,
      tokenHash: hashResetToken(`rls-${run}`),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })
    .returning({ id: schema.passwordResetTokens.id });
  tokenId = row!.id;
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  await pool.end();
});

describe("password_reset_tokens — RLS deny-all", () => {
  it("the token's own user reads zero rows under RLS", async () => {
    const rows = await asUser(userId, (tx) => tx.select().from(schema.passwordResetTokens));
    expect(rows).toEqual([]);
  });

  it("authenticated cannot read by token id either", async () => {
    const rows = await asUser(userId, (tx) =>
      tx
        .select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.id, tokenId)),
    );
    expect(rows).toEqual([]);
  });

  it("authenticated cannot insert a token", async () => {
    await expect(
      asUser(userId, (tx) =>
        tx.insert(schema.passwordResetTokens).values({
          userId,
          tokenHash: hashResetToken(`hack-${run}`),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        }),
      ),
    ).rejects.toThrow();
  });

  it("adminDb (service role) can still read the row", async () => {
    const [row] = await db
      .select({ id: schema.passwordResetTokens.id })
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.id, tokenId));
    expect(row?.id).toBe(tokenId);
  });
});
