// RLS guard for venue_sending_domains.
//
// One row per venue, holding the operator's verified-domain status
// from Resend. Cross-org reads would leak domain choices + DNS records
// to competitors; cross-org writes are even worse (forged "verified"
// status). The migration declares SELECT-only RLS for org members
// and no write policies — all writes via adminDb in server actions.

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
const emailA = `sd-a-${run}@tablekit.test`;
const emailB = `sd-b-${run}@tablekit.test`;
const PASSWORD = "integration-test-pw-1234";

let userAId: string;
let userBId: string;
let orgAId: string;
let orgBId: string;
let venueAId: string;
let venueBId: string;
let rowAId: string;
let rowBId: string;

beforeAll(async () => {
  const a = await admin.auth.admin.createUser({
    email: emailA,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Sending Domain Owner A" },
  });
  if (a.error || !a.data.user) throw a.error ?? new Error("createUser A failed");
  const b = await admin.auth.admin.createUser({
    email: emailB,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Sending Domain Owner B" },
  });
  if (b.error || !b.data.user) throw b.error ?? new Error("createUser B failed");

  userAId = a.data.user.id;
  userBId = b.data.user.id;

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `SD Org A ${run}`, slug: `sd-org-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `SD Org B ${run}`, slug: `sd-org-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");
  orgAId = orgA.id;
  orgBId = orgB.id;

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
  ]);

  const [venueA] = await db
    .insert(schema.venues)
    .values({ organisationId: orgAId, name: "Venue A", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  const [venueB] = await db
    .insert(schema.venues)
    .values({ organisationId: orgBId, name: "Venue B", venueType: "cafe" })
    .returning({ id: schema.venues.id });
  if (!venueA || !venueB) throw new Error("venue insert returned no row");
  venueAId = venueA.id;
  venueBId = venueB.id;

  const [a1] = await db
    .insert(schema.venueSendingDomains)
    .values({
      organisationId: orgAId,
      venueId: venueAId,
      domain: `mail.a-${run}.tablekit.test`,
      resendDomainId: `resend_a_${run}`,
      status: "pending",
    })
    .returning({ id: schema.venueSendingDomains.id });
  const [b1] = await db
    .insert(schema.venueSendingDomains)
    .values({
      organisationId: orgBId,
      venueId: venueBId,
      domain: `mail.b-${run}.tablekit.test`,
      resendDomainId: `resend_b_${run}`,
      status: "verified",
    })
    .returning({ id: schema.venueSendingDomains.id });
  if (!a1 || !b1) throw new Error("sending-domain insert returned no row");
  rowAId = a1.id;
  rowBId = b1.id;
});

afterAll(async () => {
  await db.delete(schema.venueSendingDomains).where(eq(schema.venueSendingDomains.id, rowAId));
  await db.delete(schema.venueSendingDomains).where(eq(schema.venueSendingDomains.id, rowBId));
  await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
  await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await pool.end();
});

describe("RLS — venue_sending_domains", () => {
  it("user A sees their venue's row, not org B's", async () => {
    const rows = await asUser(userAId, (tx) => tx.select().from(schema.venueSendingDomains));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(rowAId);
    expect(ids).not.toContain(rowBId);
  });

  it("user B sees their venue's row, not org A's", async () => {
    const rows = await asUser(userBId, (tx) => tx.select().from(schema.venueSendingDomains));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(rowBId);
    expect(ids).not.toContain(rowAId);
  });

  it("authenticated role cannot INSERT a sending-domain row directly", async () => {
    await expect(
      asUser(userAId, (tx) =>
        tx.insert(schema.venueSendingDomains).values({
          organisationId: orgAId,
          venueId: venueAId,
          domain: `forged-${run}.tablekit.test`,
          resendDomainId: `forged_${run}`,
          status: "verified",
        }),
      ),
    ).rejects.toThrow();
  });

  it("cross-org UPDATE is silently filtered (zero rows)", async () => {
    await asUser(userAId, (tx) =>
      tx
        .update(schema.venueSendingDomains)
        .set({ status: "failure" })
        .where(eq(schema.venueSendingDomains.id, rowBId)),
    );
    const [stillVerified] = await db
      .select({ status: schema.venueSendingDomains.status })
      .from(schema.venueSendingDomains)
      .where(eq(schema.venueSendingDomains.id, rowBId));
    expect(stillVerified?.status).toBe("verified");
  });
});
