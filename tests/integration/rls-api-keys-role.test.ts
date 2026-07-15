// Role-scoped RLS on api_keys (two-release policy swap, 0055 + drop).
//
// The api_keys feature is owner-only at the app layer. Migration 0055
// adds the owner-scoped `api_keys_owner_read` policy alongside the
// legacy member-wide `api_keys_member_read` from 0029. Policies OR
// together, so until the legacy policy is dropped (next release) org
// members below owner can still read key metadata — the "legacy"
// tests below pin that interim state on purpose and are flipped to
// zero-row assertions in the drop PR.
//
// Coverage:
//   - owner reads own org's keys under RLS
//   - cross-tenant isolation: owner of org B sees none of org A's keys
//   - user_owner_organisation_ids() returns only orgs where role=owner
//   - [legacy, until drop] manager + host can still read via 0029 policy

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { issueApiKey } from "@/lib/api-keys/issue";
import { loadApiKeys } from "@/lib/api-keys/list";
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

type Ctx = {
  orgAId: string;
  orgBId: string;
  ownerAId: string;
  managerAId: string;
  hostAId: string;
  ownerBId: string;
  keyAId: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const mkUser = async (tag: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `ak-role-${tag}-${run}@tablekit.test`,
      password: "integration-test-pw-1234",
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    return data.user.id;
  };

  const [ownerAId, managerAId, hostAId, ownerBId] = await Promise.all([
    mkUser("owner-a"),
    mkUser("manager-a"),
    mkUser("host-a"),
    mkUser("owner-b"),
  ]);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `AK Role A ${run}`, slug: `ak-role-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `AK Role B ${run}`, slug: `ak-role-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert failed");

  await db.insert(schema.memberships).values([
    { userId: ownerAId, organisationId: orgA.id, role: "owner" },
    { userId: managerAId, organisationId: orgA.id, role: "manager" },
    { userId: hostAId, organisationId: orgA.id, role: "host" },
    { userId: ownerBId, organisationId: orgB.id, role: "owner" },
  ]);

  const issued = await issueApiKey({
    organisationId: orgA.id,
    label: "rls-role-test",
    createdByUserId: ownerAId,
  });

  ctx = {
    orgAId: orgA.id,
    orgBId: orgB.id,
    ownerAId,
    managerAId,
    hostAId,
    ownerBId,
    keyAId: issued.id,
  };
});

afterAll(async () => {
  if (ctx) {
    for (const id of [ctx.ownerAId, ctx.managerAId, ctx.hostAId, ctx.ownerBId]) {
      await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

describe("user_owner_organisation_ids()", () => {
  it("returns the org for an owner", async () => {
    const rows = await asUser(ctx.ownerAId, async (tx) => {
      const r = (await tx.execute(
        sql`select public.user_owner_organisation_ids() as id`,
      )) as unknown as { rows?: Array<{ id: string }> };
      return r.rows ?? [];
    });
    expect(rows.map((r) => r.id)).toContain(ctx.orgAId);
  });

  it("returns nothing for manager and host", async () => {
    for (const userId of [ctx.managerAId, ctx.hostAId]) {
      const rows = await asUser(userId, async (tx) => {
        const r = (await tx.execute(
          sql`select public.user_owner_organisation_ids() as id`,
        )) as unknown as { rows?: Array<{ id: string }> };
        return r.rows ?? [];
      });
      expect(rows).toHaveLength(0);
    }
  });
});

describe("api_keys RLS", () => {
  it("owner reads own org's keys", async () => {
    const rows = await asUser(ctx.ownerAId, (tx) => loadApiKeys(tx, ctx.orgAId));
    expect(rows.some((r) => r.id === ctx.keyAId)).toBe(true);
  });

  it("cross-tenant: org B owner sees none of org A's keys", async () => {
    const rows = await asUser(ctx.ownerBId, (tx) => loadApiKeys(tx, ctx.orgAId));
    expect(rows).toHaveLength(0);
  });

  // Interim state: the legacy member-wide policy from 0029 still
  // grants read to manager/host until it is dropped next release.
  // The drop PR flips both assertions to `toHaveLength(0)`.
  it("[legacy until member_read drop] manager can still read key metadata", async () => {
    const rows = await asUser(ctx.managerAId, (tx) => loadApiKeys(tx, ctx.orgAId));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("[legacy until member_read drop] host can still read key metadata", async () => {
    const rows = await asUser(ctx.hostAId, (tx) => loadApiKeys(tx, ctx.orgAId));
    expect(rows.length).toBeGreaterThan(0);
  });
});
