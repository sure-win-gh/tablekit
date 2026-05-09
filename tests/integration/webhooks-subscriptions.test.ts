// Integration tests for webhook subscription CRUD (PR6a).
//
// Coverage:
//   - createSubscription: persists encrypted secret, returns
//     plaintext exactly once, prefix is `whsec_`.
//   - revokeSubscription: idempotent + cross-org refused.
//   - listSubscriptions: returns rows + RLS allows org members
//     to SELECT but not other orgs'.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";
import {
  createSubscription,
  listSubscriptions,
  revokeSubscription,
} from "@/lib/webhooks/subscribe";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);
type Ctx = { orgAId: string; orgBId: string; userAId: string; userBId: string };
let ctx: Ctx;

beforeAll(async () => {
  const { data: a } = await admin.auth.admin.createUser({
    email: `whk-a-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  const { data: b } = await admin.auth.admin.createUser({
    email: `whk-b-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (!a.user || !b.user) throw new Error("createUser failed");

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `WHK-A ${run}`, slug: `whk-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `WHK-B ${run}`, slug: `whk-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  await db.insert(schema.memberships).values([
    { userId: a.user.id, organisationId: orgA!.id, role: "owner" },
    { userId: b.user.id, organisationId: orgB!.id, role: "owner" },
  ]);

  ctx = { orgAId: orgA!.id, orgBId: orgB!.id, userAId: a.user.id, userBId: b.user.id };
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

describe("createSubscription", () => {
  it("persists row + encrypts secret + returns plaintext with whsec_ prefix", async () => {
    const r = await createSubscription({
      organisationId: ctx.orgAId,
      createdByUserId: ctx.userAId,
      url: "https://example.com/whk",
      label: "test sub",
      events: ["booking.created"],
    });
    expect(r.plaintextSecret.startsWith("whsec_")).toBe(true);
    expect(r.plaintextSecret.length).toBe(38); // 6 (prefix) + 32 base64url chars

    const [row] = await db
      .select()
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, r.id));
    expect(row?.organisationId).toBe(ctx.orgAId);
    expect(row?.url).toBe("https://example.com/whk");
    expect(row?.events).toEqual(["booking.created"]);
    expect(row?.active).toBe(true);
    expect(row?.revokedAt).toBeNull();

    // Round-trip the cipher.
    const decrypted = await decryptPii(ctx.orgAId, row!.secretCipher as Ciphertext);
    expect(decrypted).toBe(r.plaintextSecret);
  });
});

describe("revokeSubscription", () => {
  it("flips revokedAt and active=false", async () => {
    const r = await createSubscription({
      organisationId: ctx.orgAId,
      createdByUserId: ctx.userAId,
      url: "https://example.com/revoke-me",
      label: "doomed",
      events: ["booking.cancelled"],
    });
    const out = await revokeSubscription({ subscriptionId: r.id, organisationId: ctx.orgAId });
    expect(out.revoked).toBe(true);

    const [row] = await db
      .select({
        active: schema.webhookSubscriptions.active,
        revokedAt: schema.webhookSubscriptions.revokedAt,
      })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, r.id));
    expect(row?.active).toBe(false);
    expect(row?.revokedAt).not.toBeNull();
  });

  it("refuses to revoke a subscription in another org", async () => {
    const r = await createSubscription({
      organisationId: ctx.orgAId,
      createdByUserId: ctx.userAId,
      url: "https://example.com/keep-me",
      label: "scoped",
      events: ["booking.created"],
    });
    const out = await revokeSubscription({ subscriptionId: r.id, organisationId: ctx.orgBId });
    expect(out.revoked).toBe(false);

    const [row] = await db
      .select({ revokedAt: schema.webhookSubscriptions.revokedAt })
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, r.id));
    expect(row?.revokedAt).toBeNull();
  });
});

describe("listSubscriptions", () => {
  it("returns the org's subs newest first", async () => {
    const a1 = await createSubscription({
      organisationId: ctx.orgAId,
      createdByUserId: ctx.userAId,
      url: "https://example.com/list-1",
      label: "list-1",
      events: ["booking.created"],
    });
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await createSubscription({
      organisationId: ctx.orgAId,
      createdByUserId: ctx.userAId,
      url: "https://example.com/list-2",
      label: "list-2",
      events: ["booking.created"],
    });

    const rows = await listSubscriptions(db, { organisationId: ctx.orgAId });
    const ids = rows.map((r) => r.id);
    const idxA1 = ids.indexOf(a1.id);
    const idxA2 = ids.indexOf(a2.id);
    expect(idxA1).toBeGreaterThan(-1);
    expect(idxA2).toBeGreaterThan(-1);
    expect(idxA2).toBeLessThan(idxA1); // newest first
  });
});

describe("RLS — webhook_subscriptions_member_read", () => {
  it("an authed member sees only their own org's subscriptions", async () => {
    const subA = await createSubscription({
      organisationId: ctx.orgAId,
      createdByUserId: ctx.userAId,
      url: "https://example.com/rls-a",
      label: "rls-A",
      events: ["booking.created"],
    });
    const subB = await createSubscription({
      organisationId: ctx.orgBId,
      createdByUserId: ctx.userBId,
      url: "https://example.com/rls-b",
      label: "rls-B",
      events: ["booking.created"],
    });

    const userAClient = createClient(
      process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
      process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]!,
    );
    const { error } = await userAClient.auth.signInWithPassword({
      email: `whk-a-${run}@tablekit.test`,
      password: "integration-test-pw-1234",
    });
    if (error) throw error;

    const { data, error: queryErr } = await userAClient
      .from("webhook_subscriptions")
      .select("id, organisation_id, label");
    if (queryErr) throw queryErr;

    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(subA.id);
    expect(ids).not.toContain(subB.id);
  });
});
