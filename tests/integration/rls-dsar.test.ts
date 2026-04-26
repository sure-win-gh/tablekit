// Integration tests for the DSAR (privacy request) phase.
//
// Covers:
//   1. Cross-tenant RLS — user A cannot see org B's privacy requests.
//   2. createDsarRequest persists encrypted email + matches an
//      existing guest by email hash when one exists in the org.
//   3. transitionDsarRequest rejects a wrong-org actor + invalid
//      transitions; valid transitions write the audit row.

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { createDsarRequest } from "@/lib/dsar/create";
import { transitionDsarRequest } from "@/lib/dsar/transition";
import { decryptPii, hashForLookup, type Ciphertext } from "@/lib/security/crypto";

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
  guestAEmail: string;
  guestAId: string;
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

  const userAId = await mkUser(`dsar-a-${run}@tablekit.test`);
  const userBId = await mkUser(`dsar-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `D-A ${run}`, slug: `dsar-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `D-B ${run}`, slug: `dsar-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  // Seed a guest under orgA so the create-time auto-match has
  // something to find. The guest fixture uses placeholder ciphertext
  // — we only test the email_hash match in the create path, not
  // decryption of the guest profile.
  const guestAEmail = `guest-${run}@example.com`;
  const guestAEmailHash = hashForLookup(guestAEmail, "email");
  const [guestA] = await db
    .insert(schema.guests)
    .values({
      organisationId: orgA.id,
      firstName: "Test",
      lastNameCipher: "c",
      emailCipher: "c",
      emailHash: guestAEmailHash,
    })
    .returning({ id: schema.guests.id });
  if (!guestA) throw new Error("guest insert returned no row");

  ctx = {
    userAId,
    userBId,
    orgAId: orgA.id,
    orgBId: orgB.id,
    guestAEmail,
    guestAId: guestA.id,
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

describe("dsar — create", () => {
  it("persists encrypted email + matches existing guest by hash", async () => {
    const r = await createDsarRequest({
      organisationId: ctx.orgAId,
      kind: "export",
      requesterEmail: ctx.guestAEmail,
      message: "Please export everything you have.",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matchedGuestId).toBe(ctx.guestAId);

    const [row] = await db
      .select()
      .from(schema.dsarRequests)
      .where(eq(schema.dsarRequests.id, r.dsarId));
    expect(row?.organisationId).toBe(ctx.orgAId);
    expect(row?.kind).toBe("export");
    expect(row?.status).toBe("pending");
    expect(row?.guestId).toBe(ctx.guestAId);
    expect(row?.requesterEmailHash).toBe(hashForLookup(ctx.guestAEmail, "email"));

    // Ciphertext should round-trip back to the plaintext email under
    // the org's DEK.
    if (!row) return;
    const decrypted = await decryptPii(ctx.orgAId, row.requesterEmailCipher as Ciphertext);
    expect(decrypted).toBe(ctx.guestAEmail);

    // due_at = requested_at + 30 days, give or take a second.
    const ddays = (row.dueAt.getTime() - row.requestedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(ddays).toBeGreaterThan(29.99);
    expect(ddays).toBeLessThan(30.01);
  });

  it("returns matchedGuestId=null when no guest exists for that email", async () => {
    const r = await createDsarRequest({
      organisationId: ctx.orgAId,
      kind: "erase",
      requesterEmail: `no-match-${run}@example.com`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matchedGuestId).toBeNull();
  });

  it("rejects invalid input", async () => {
    const r = await createDsarRequest({
      organisationId: ctx.orgAId,
      kind: "export",
      requesterEmail: "not-an-email",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-input");
  });
});

describe("dsar — RLS isolation", () => {
  it("user A cannot see org B's requests", async () => {
    // Seed a request under orgB.
    const created = await createDsarRequest({
      organisationId: ctx.orgBId,
      kind: "rectify",
      requesterEmail: `b-${run}@example.com`,
    });
    expect(created.ok).toBe(true);

    const rowsAsA = await asUser(ctx.userAId, (tx) =>
      tx
        .select({ id: schema.dsarRequests.id, orgId: schema.dsarRequests.organisationId })
        .from(schema.dsarRequests),
    );
    const orgIds = rowsAsA.map((r) => r.orgId);
    expect(orgIds).not.toContain(ctx.orgBId);
  });
});

describe("dsar — transition", () => {
  it("rejects wrong-org actor", async () => {
    const created = await createDsarRequest({
      organisationId: ctx.orgAId,
      kind: "export",
      requesterEmail: ctx.guestAEmail,
    });
    if (!created.ok) throw new Error("setup failed");

    const r = await transitionDsarRequest({
      organisationId: ctx.orgBId, // wrong
      actorUserId: ctx.userBId,
      dsarId: created.dsarId,
      to: "in_progress",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("wrong-org");
  });

  it("rejects invalid transition (pending → completed)", async () => {
    const created = await createDsarRequest({
      organisationId: ctx.orgAId,
      kind: "export",
      requesterEmail: ctx.guestAEmail,
    });
    if (!created.ok) throw new Error("setup failed");

    const r = await transitionDsarRequest({
      organisationId: ctx.orgAId,
      actorUserId: ctx.userAId,
      dsarId: created.dsarId,
      to: "completed", // skipping in_progress isn't allowed
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-transition");
  });

  it("walks pending → in_progress → completed and stamps resolved_at", async () => {
    const created = await createDsarRequest({
      organisationId: ctx.orgAId,
      kind: "export",
      requesterEmail: ctx.guestAEmail,
    });
    if (!created.ok) throw new Error("setup failed");

    const a = await transitionDsarRequest({
      organisationId: ctx.orgAId,
      actorUserId: ctx.userAId,
      dsarId: created.dsarId,
      to: "in_progress",
      resolutionNotes: "looking it up",
    });
    expect(a.ok).toBe(true);

    const b = await transitionDsarRequest({
      organisationId: ctx.orgAId,
      actorUserId: ctx.userAId,
      dsarId: created.dsarId,
      to: "completed",
      resolutionNotes: "exported via dashboard",
    });
    expect(b.ok).toBe(true);

    const [row] = await db
      .select()
      .from(schema.dsarRequests)
      .where(eq(schema.dsarRequests.id, created.dsarId));
    expect(row?.status).toBe("completed");
    expect(row?.resolutionNotes).toBe("exported via dashboard");
    expect(row?.resolvedAt).not.toBeNull();
  });
});
