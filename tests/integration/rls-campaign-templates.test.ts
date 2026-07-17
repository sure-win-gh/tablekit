// Integration test for campaign_templates (marketing-suite: saved email
// designs). Cross-tenant RLS isolation (rule 3): members read only their
// own org's templates; the authenticated role cannot write directly (all
// writes go through org-guarded server actions via adminDb).

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

const DOC = { v: 1, blocks: [{ type: "text", text: "Hi {{guestFirstName}}" }] };

type Ctx = { userAId: string; userBId: string; orgAId: string; orgBId: string };
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

  const userAId = await mkUser(`tpl-a-${run}@tablekit.test`);
  const userBId = await mkUser(`tpl-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `TPL-A ${run}`, slug: `tpl-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `TPL-B ${run}`, slug: `tpl-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgA.id, role: "owner" },
    { userId: userBId, organisationId: orgB.id, role: "owner" },
  ]);

  await db.insert(schema.campaignTemplates).values([
    { organisationId: orgA.id, name: "A template", bodyDoc: DOC },
    { organisationId: orgB.id, name: "B template", bodyDoc: DOC },
  ]);

  ctx = { userAId, userBId, orgAId: orgA.id, orgBId: orgB.id };
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

describe("campaign_templates — cross-tenant RLS", () => {
  it("user A reads only org A's templates; user B only org B's", async () => {
    const aRows = await asUser(ctx.userAId, (tx) => tx.select().from(schema.campaignTemplates));
    expect(aRows.length).toBeGreaterThan(0);
    expect(aRows.every((r) => r.organisationId === ctx.orgAId)).toBe(true);

    const bRows = await asUser(ctx.userBId, (tx) => tx.select().from(schema.campaignTemplates));
    expect(bRows.length).toBeGreaterThan(0);
    expect(bRows.every((r) => r.organisationId === ctx.orgBId)).toBe(true);
  });

  it("authenticated cannot insert, update or delete templates directly", async () => {
    await expect(
      asUser(ctx.userAId, (tx) =>
        tx
          .insert(schema.campaignTemplates)
          .values({ organisationId: ctx.orgAId, name: "hack", bodyDoc: DOC }),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(ctx.userAId, async (tx) => {
        const r = await tx
          .update(schema.campaignTemplates)
          .set({ name: "renamed" })
          .where(eq(schema.campaignTemplates.organisationId, ctx.orgAId))
          .returning({ id: schema.campaignTemplates.id });
        // RLS row-filtering may silently update 0 rows rather than throw.
        if (r.length === 0) throw new Error("no rows updated");
      }),
    ).rejects.toThrow();
    await expect(
      asUser(ctx.userAId, async (tx) => {
        const r = await tx
          .delete(schema.campaignTemplates)
          .where(eq(schema.campaignTemplates.organisationId, ctx.orgAId))
          .returning({ id: schema.campaignTemplates.id });
        if (r.length === 0) throw new Error("no rows deleted");
      }),
    ).rejects.toThrow();
  });
});
