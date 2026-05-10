// RLS guard for org_invitations.
//
// org_invitations stores team invite tokens (hash + email + role). Two
// orgs must not see each other's pending invites — leaking emails or
// roles across tenants is a privacy bug. The table also has no write
// policies for `authenticated`; all mutations go through adminDb in
// server actions, so a forged INSERT from a logged-in user must fail.

import { createHash, randomBytes } from "node:crypto";

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
const emailA = `inv-a-${run}@tablekit.test`;
const emailB = `inv-b-${run}@tablekit.test`;
const PASSWORD = "integration-test-pw-1234";

let userAId: string;
let userBId: string;
let orgAId: string;
let orgBId: string;
let inviteAId: string;
let inviteBId: string;

beforeAll(async () => {
  const a = await admin.auth.admin.createUser({
    email: emailA,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Invite Owner A" },
  });
  if (a.error || !a.data.user) throw a.error ?? new Error("createUser A failed");
  const b = await admin.auth.admin.createUser({
    email: emailB,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Invite Owner B" },
  });
  if (b.error || !b.data.user) throw b.error ?? new Error("createUser B failed");

  userAId = a.data.user.id;
  userBId = b.data.user.id;

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Inv Org A ${run}`, slug: `inv-org-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Inv Org B ${run}`, slug: `inv-org-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");
  orgAId = orgA.id;
  orgBId = orgB.id;

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
  ]);

  // Seed one pending invitation per org. Use realistic-shape token
  // hashes so a future migration tightening token_hash format doesn't
  // silently succeed in tests.
  const hashA = createHash("sha256").update(randomBytes(32)).digest("hex");
  const hashB = createHash("sha256").update(randomBytes(32)).digest("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  const [a1] = await db
    .insert(schema.orgInvitations)
    .values({
      organisationId: orgAId,
      email: `pending-a-${run}@tablekit.test`,
      role: "manager",
      tokenHash: hashA,
      invitedByUserId: userAId,
      expiresAt,
    })
    .returning({ id: schema.orgInvitations.id });
  const [b1] = await db
    .insert(schema.orgInvitations)
    .values({
      organisationId: orgBId,
      email: `pending-b-${run}@tablekit.test`,
      role: "host",
      tokenHash: hashB,
      invitedByUserId: userBId,
      expiresAt,
    })
    .returning({ id: schema.orgInvitations.id });
  if (!a1 || !b1) throw new Error("invitation seed insert returned no row");
  inviteAId = a1.id;
  inviteBId = b1.id;
});

afterAll(async () => {
  await db.delete(schema.orgInvitations).where(eq(schema.orgInvitations.id, inviteAId));
  await db.delete(schema.orgInvitations).where(eq(schema.orgInvitations.id, inviteBId));
  await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
  await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await pool.end();
});

describe("RLS — org_invitations", () => {
  it("user A sees their own org's pending invite, not org B's", async () => {
    const rows = await asUser(userAId, (tx) => tx.select().from(schema.orgInvitations));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(inviteAId);
    expect(ids).not.toContain(inviteBId);
  });

  it("user B sees their own org's pending invite, not org A's", async () => {
    const rows = await asUser(userBId, (tx) => tx.select().from(schema.orgInvitations));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(inviteBId);
    expect(ids).not.toContain(inviteAId);
  });

  it("authenticated role cannot insert an invitation directly", async () => {
    // No write policy is declared for org_invitations — INSERTs from
    // the authenticated role must fail outright. Server actions use
    // adminDb which sidesteps RLS.
    await expect(
      asUser(userAId, (tx) =>
        tx.insert(schema.orgInvitations).values({
          organisationId: orgAId,
          email: `forged-${run}@tablekit.test`,
          role: "owner",
          tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
          invitedByUserId: userAId,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated role cannot UPDATE another org's invitation (silent zero rows)", async () => {
    // No UPDATE policy → the statement runs but affects 0 rows. We
    // verify by re-reading the row as admin and confirming revokedAt
    // is still null on org B's invite.
    await asUser(userAId, (tx) =>
      tx
        .update(schema.orgInvitations)
        .set({ revokedAt: new Date() })
        .where(eq(schema.orgInvitations.id, inviteBId)),
    );

    const rows = await db
      .select({ revokedAt: schema.orgInvitations.revokedAt })
      .from(schema.orgInvitations)
      .where(eq(schema.orgInvitations.id, inviteBId));
    expect(rows[0]?.revokedAt).toBeNull();
  });
});
