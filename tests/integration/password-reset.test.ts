// Integration tests for the password-reset token lifecycle against a real DB.
// Covers the acceptance criteria in docs/specs/password-reset.md: single-use,
// 15-min expiry, re-mint invalidation, hash-only storage, and the retention
// sweep.

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  consumeResetToken,
  hashResetToken,
  mintResetToken,
  resolveResetToken,
  sweepResetTokenRetention,
} from "@/lib/auth/password-reset";
import * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);
let userId: string;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `pwreset-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  userId = data.user.id;
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  await pool.end();
});

describe("mint + resolve", () => {
  it("mints a live token that resolves to the user and stores only the hash", async () => {
    const { tokenId, token } = await mintResetToken(userId);
    const resolved = await resolveResetToken(token);
    expect(resolved).toEqual({ userId });

    // The row stores the hash, never the plaintext.
    const [row] = await db
      .select({ tokenHash: schema.passwordResetTokens.tokenHash })
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.id, tokenId));
    expect(row?.tokenHash).toBe(hashResetToken(token));
    expect(row?.tokenHash).not.toBe(token);
  });
});

describe("single-use", () => {
  it("consumes a token exactly once", async () => {
    const { token } = await mintResetToken(userId);
    expect(await consumeResetToken(token)).toEqual({ userId });
    // Second consume + a read-only resolve both fail after use.
    expect(await consumeResetToken(token)).toBeNull();
    expect(await resolveResetToken(token)).toBeNull();
  });
});

describe("expiry", () => {
  it("rejects a token past its 15-minute window", async () => {
    const { token } = await mintResetToken(userId, { ttlMs: -1_000 });
    expect(await resolveResetToken(token)).toBeNull();
    expect(await consumeResetToken(token)).toBeNull();
  });
});

describe("re-mint invalidation", () => {
  it("invalidates a prior unused token when a new one is minted", async () => {
    const first = await mintResetToken(userId);
    const second = await mintResetToken(userId);
    expect(await resolveResetToken(first.token)).toBeNull();
    expect(await resolveResetToken(second.token)).toEqual({ userId });
  });
});

describe("retention sweep", () => {
  it("deletes used/expired rows past the 24h grace, keeps live ones", async () => {
    // Insert a USED-25h-ago row directly — mint() only clears *unused* rows,
    // so this survives until the sweep removes it.
    const staleHash = hashResetToken(`stale-${run}`);
    await db.insert(schema.passwordResetTokens).values({
      userId,
      tokenHash: staleHash,
      expiresAt: new Date(Date.now() - 60_000),
      usedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const live = await mintResetToken(userId);

    const { deleted } = await sweepResetTokenRetention();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const [stale] = await db
      .select({ id: schema.passwordResetTokens.id })
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.tokenHash, staleHash));
    expect(stale).toBeUndefined();
    // The live token survives the sweep.
    expect(await resolveResetToken(live.token)).toEqual({ userId });
  });
});

describe("unknown token", () => {
  it("resolves to null for a token that was never minted", async () => {
    expect(await resolveResetToken("not-a-real-token")).toBeNull();
    expect(await consumeResetToken("not-a-real-token")).toBeNull();
  });
});

describe("admin-initiated mint", () => {
  // The support flow reuses mintResetToken with initiatedByAdminId set, so
  // the token row records which admin triggered it (forensics + email copy).
  it("tags the token with the initiating admin id", async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `pwreset-admin-${run}@tablekit.test`,
      password: "integration-test-pw-1234",
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("createUser (admin) failed");
    const adminId = data.user.id;

    try {
      const { tokenId } = await mintResetToken(userId, { initiatedByAdminId: adminId });
      const [row] = await db
        .select({
          userId: schema.passwordResetTokens.userId,
          initiatedByAdminId: schema.passwordResetTokens.initiatedByAdminId,
        })
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.id, tokenId));
      expect(row?.userId).toBe(userId);
      expect(row?.initiatedByAdminId).toBe(adminId);
    } finally {
      await admin.auth.admin.deleteUser(adminId).catch(() => undefined);
    }
  });
});

describe("session revocation", () => {
  // The reset action revokes the user's other sessions via a service-role
  // `delete from auth.sessions`. Prove the adminDb role has that grant and
  // that it actually clears a live session (the riskiest runtime path).
  it("the service-role connection can delete the user's auth.sessions", async () => {
    const anon = createClient(
      process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
      process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error } = await anon.auth.signInWithPassword({
      email: `pwreset-${run}@tablekit.test`,
      password: "integration-test-pw-1234",
    });
    expect(error).toBeNull();

    const before = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from auth.sessions where user_id = ${userId}`,
    );
    expect(Number(before.rows[0]?.n)).toBeGreaterThanOrEqual(1);

    await db.execute(sql`delete from auth.sessions where user_id = ${userId}`);

    const after = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from auth.sessions where user_id = ${userId}`,
    );
    expect(Number(after.rows[0]?.n)).toBe(0);
  });
});
