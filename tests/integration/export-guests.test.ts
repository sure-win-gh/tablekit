// End-to-end coverage of the guests-export read path.
//
// Asserts:
//   1. loadGuestsForExport decrypts PII back to the original plaintext
//      under the owning org's DEK (no other module touched the wrapped
//      DEK along the way).
//   2. RLS scopes the SELECT — running under user A's transaction
//      returns only org A's rows.
//   3. Erased rows are excluded from the export (we never decrypt a
//      tombstoned cipher).

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { loadGuestsForExport } from "@/lib/export/guests";
import { upsertGuest } from "@/lib/guests/upsert";

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
let userAId: string;
let userBId: string;
// userAB is a member of BOTH org A and org B. This is the case that
// exposes the dual-org leak: RLS alone admits rows from every org
// the caller belongs to, so the export reader must filter by
// the active orgId or it'll attempt to decrypt org B's ciphers
// under org A's DEK (and crash, masking a 500 over a real leak).
let userABId: string;
let orgAId: string;
let orgBId: string;
let janeIdInOrgA: string;
let bobbyIdInOrgB: string;
let erasedIdInOrgA: string;

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

  userAId = await mkUser(`export-a-${run}@tablekit.test`);
  userBId = await mkUser(`export-b-${run}@tablekit.test`);
  userABId = await mkUser(`export-ab-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Export A ${run}`, slug: `export-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Export B ${run}`, slug: `export-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");
  orgAId = orgA.id;
  orgBId = orgB.id;

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
    { userId: userABId, organisationId: orgAId, role: "owner" },
    { userId: userABId, organisationId: orgBId, role: "owner" },
  ]);

  // Org A: Jane (active) + Erased (tombstoned).
  const jane = await upsertGuest(orgAId, userAId, {
    firstName: "Jane",
    lastName: "Doe",
    email: `jane-${run}@example.com`,
    phone: "+447700900123",
  });
  if (!jane.ok) throw new Error("seed jane failed");
  janeIdInOrgA = jane.guestId;

  const erased = await upsertGuest(orgAId, userAId, {
    firstName: "Ghost",
    lastName: "Past",
    email: `ghost-${run}@example.com`,
  });
  if (!erased.ok) throw new Error("seed ghost failed");
  erasedIdInOrgA = erased.guestId;
  await db
    .update(schema.guests)
    .set({ erasedAt: new Date() })
    .where(eq(schema.guests.id, erasedIdInOrgA));

  // Org B: Bobby (must never appear in A's export).
  const bobby = await upsertGuest(orgBId, userBId, {
    firstName: "Bobby",
    lastName: "Tables",
    email: `bobby-${run}@example.com`,
  });
  if (!bobby.ok) throw new Error("seed bobby failed");
  bobbyIdInOrgB = bobby.guestId;
});

afterAll(async () => {
  if (userAId) await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
  if (userBId) await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
  if (userABId) await admin.auth.admin.deleteUser(userABId).catch(() => undefined);
  if (orgAId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  if (orgBId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await pool.end();
});

describe("loadGuestsForExport", () => {
  it("decrypts PII back to plaintext under the owning org's DEK", async () => {
    const rows = await asUser(userAId, (tx) => loadGuestsForExport(tx, orgAId));
    const jane = rows.find((r) => r.guestId === janeIdInOrgA);
    expect(jane).toBeDefined();
    expect(jane?.email).toBe(`jane-${run}@example.com`);
    expect(jane?.lastName).toBe("Doe");
    expect(jane?.phone).toBe("+447700900123");
  });

  it("excludes erased rows", async () => {
    const rows = await asUser(userAId, (tx) => loadGuestsForExport(tx, orgAId));
    expect(rows.find((r) => r.guestId === erasedIdInOrgA)).toBeUndefined();
  });

  it("RLS confines results to the active org — A never sees B's guests", async () => {
    const rows = await asUser(userAId, (tx) => loadGuestsForExport(tx, orgAId));
    expect(rows.find((r) => r.guestId === bobbyIdInOrgB)).toBeUndefined();
  });

  it("dual-org user exporting org A gets only org A's rows (not org B's)", async () => {
    // RLS would admit both orgs' rows for this user; the explicit
    // orgId filter inside loadGuestsForExport must prove the active
    // org wins. Without the filter, this test would either crash
    // (DEK mismatch) or silently leak Bobby into Jane's export.
    const rows = await asUser(userABId, (tx) => loadGuestsForExport(tx, orgAId));
    expect(rows.find((r) => r.guestId === janeIdInOrgA)).toBeDefined();
    expect(rows.find((r) => r.guestId === bobbyIdInOrgB)).toBeUndefined();
    // And the inverse: exporting org B from the same session.
    const rowsB = await asUser(userABId, (tx) => loadGuestsForExport(tx, orgBId));
    expect(rowsB.find((r) => r.guestId === bobbyIdInOrgB)).toBeDefined();
    expect(rowsB.find((r) => r.guestId === janeIdInOrgA)).toBeUndefined();
  });
});
