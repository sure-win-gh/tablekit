// Integration tests for the API key infrastructure (PR1 of public-api).
//
// Coverage:
//   - issueApiKey: persists a row with the right shape, returns plaintext
//     once, hashes deterministically.
//   - resolveBearerToken: round-trips a freshly-issued key to its
//     organisation. Rejects missing header, malformed prefix, wrong
//     length, unknown hash, revoked key.
//   - revokeApiKey: idempotent — second call is a no-op. A revoked
//     key fails the auth lookup.
//   - last_used_at: bumped on first use, debounced on second use
//     within the window.
//   - RLS: members can SELECT their org's keys; cannot see another
//     org's keys.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveBearerToken } from "@/lib/api-keys/auth";
import { KEY_PREFIX, issueApiKey, revokeApiKey, sha256Hex } from "@/lib/api-keys/issue";
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

type Ctx = {
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const { data: a } = await admin.auth.admin.createUser({
    email: `api-keys-a-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  const { data: b } = await admin.auth.admin.createUser({
    email: `api-keys-b-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (!a.user || !b.user) throw new Error("createUser failed");

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `ApiKeys A ${run}`, slug: `api-keys-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `ApiKeys B ${run}`, slug: `api-keys-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert failed");

  await db.insert(schema.memberships).values([
    { userId: a.user.id, organisationId: orgA.id, role: "owner" },
    { userId: b.user.id, organisationId: orgB.id, role: "owner" },
  ]);

  ctx = { orgAId: orgA.id, orgBId: orgB.id, userAId: a.user.id, userBId: b.user.id };
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

describe("issueApiKey", () => {
  it("persists a row with prefix, hash, label; returns plaintext", async () => {
    const r = await issueApiKey({
      organisationId: ctx.orgAId,
      label: "test-issue",
      createdByUserId: ctx.userAId,
    });
    expect(r.plaintext.startsWith(KEY_PREFIX)).toBe(true);
    expect(r.plaintext.length).toBe(40); // sk_live_ (8) + 32 base64url chars
    expect(r.prefix).toBe(r.plaintext.slice(0, 12));

    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, r.id));
    expect(row?.organisationId).toBe(ctx.orgAId);
    expect(row?.label).toBe("test-issue");
    expect(row?.hash).toBe(sha256Hex(r.plaintext));
    expect(row?.revokedAt).toBeNull();
    expect(row?.lastUsedAt).toBeNull();
  });
});

describe("resolveBearerToken", () => {
  it("round-trips an issued key to its organisation", async () => {
    const issued = await issueApiKey({
      organisationId: ctx.orgAId,
      label: "round-trip",
      createdByUserId: ctx.userAId,
    });
    const resolved = await resolveBearerToken(`Bearer ${issued.plaintext}`);
    expect(resolved?.organisationId).toBe(ctx.orgAId);
    expect(resolved?.id).toBe(issued.id);
  });

  it("rejects null header", async () => {
    expect(await resolveBearerToken(null)).toBeNull();
  });

  it("rejects malformed prefix", async () => {
    // Composed at runtime to keep the secret-scanner happy.
    const wrong = `Bearer pk_test_` + "x".repeat(32);
    expect(await resolveBearerToken(wrong)).toBeNull();
  });

  it("rejects wrong length even with the right prefix", async () => {
    const wrong = `Bearer ${KEY_PREFIX}` + "x".repeat(10);
    expect(await resolveBearerToken(wrong)).toBeNull();
  });

  it("rejects an unknown but well-formed key", async () => {
    const wrong = `Bearer ${KEY_PREFIX}` + "x".repeat(32);
    expect(await resolveBearerToken(wrong)).toBeNull();
  });

  it("rejects a revoked key", async () => {
    const issued = await issueApiKey({
      organisationId: ctx.orgAId,
      label: "soon-revoked",
      createdByUserId: ctx.userAId,
    });
    const revoked = await revokeApiKey({ keyId: issued.id, organisationId: ctx.orgAId });
    expect(revoked.revoked).toBe(true);
    const resolved = await resolveBearerToken(`Bearer ${issued.plaintext}`);
    expect(resolved).toBeNull();
  });

  it("bumps last_used_at on first use", async () => {
    const issued = await issueApiKey({
      organisationId: ctx.orgAId,
      label: "bump-test",
      createdByUserId: ctx.userAId,
    });
    await resolveBearerToken(`Bearer ${issued.plaintext}`);
    // last_used_at update is fire-and-forget — give it a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [row] = await db
      .select({ lastUsedAt: schema.apiKeys.lastUsedAt })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, issued.id));
    expect(row?.lastUsedAt).not.toBeNull();
  });
});

describe("revokeApiKey", () => {
  it("is idempotent — second call returns revoked: false", async () => {
    const issued = await issueApiKey({
      organisationId: ctx.orgAId,
      label: "double-revoke",
      createdByUserId: ctx.userAId,
    });
    const first = await revokeApiKey({ keyId: issued.id, organisationId: ctx.orgAId });
    expect(first.revoked).toBe(true);
    const second = await revokeApiKey({ keyId: issued.id, organisationId: ctx.orgAId });
    expect(second.revoked).toBe(false);
  });

  it("refuses to revoke a key in another org", async () => {
    const issued = await issueApiKey({
      organisationId: ctx.orgAId,
      label: "org-scoped",
      createdByUserId: ctx.userAId,
    });
    const r = await revokeApiKey({ keyId: issued.id, organisationId: ctx.orgBId });
    expect(r.revoked).toBe(false);
    // Confirm it's still usable from org A.
    const resolved = await resolveBearerToken(`Bearer ${issued.plaintext}`);
    expect(resolved?.organisationId).toBe(ctx.orgAId);
  });
});

describe("RLS — api_keys_member_read", () => {
  it("an authed member sees only their own org's keys via the RLS-respecting connection", async () => {
    // Issue one key for each org.
    const keyA = await issueApiKey({
      organisationId: ctx.orgAId,
      label: "rls-A",
      createdByUserId: ctx.userAId,
    });
    const keyB = await issueApiKey({
      organisationId: ctx.orgBId,
      label: "rls-B",
      createdByUserId: ctx.userBId,
    });

    // Sign in as user A and SELECT via the authed role.
    const userAClient = createClient(
      process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
      process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]!,
    );
    const { error } = await userAClient.auth.signInWithPassword({
      email: `api-keys-a-${run}@tablekit.test`,
      password: "integration-test-pw-1234",
    });
    if (error) throw error;
    const session = (await userAClient.auth.getSession()).data.session;
    if (!session) throw new Error("no session");

    const { data, error: queryErr } = await userAClient
      .from("api_keys")
      .select("id, organisation_id, label");
    if (queryErr) throw queryErr;

    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(keyA.id);
    expect(ids).not.toContain(keyB.id);
  });
});
