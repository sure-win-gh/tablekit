// Cross-tenant RLS + upsert behaviour for the guests-minimal phase.
//
// Asserts:
//   1. guests_member_read: user A cannot see org B's guests
//   2. authenticated role cannot insert into guests directly (no INSERT
//      policy — writes route through server actions via adminDb)
//   3. upsertGuest encrypts PII (cipher columns != plaintext)
//   4. upsertGuest dedups by (org_id, email_hash): same email reuses
//      the same id; phone gets added on second call; first name refreshes
//   5. same email in a different org creates a separate row

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { upsertGuest } from "@/lib/guests/upsert";
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
let userAId: string;
let userBId: string;
let orgAId: string;
let orgBId: string;

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

  userAId = await mkUser(`guests-a-${run}@tablekit.test`);
  userBId = await mkUser(`guests-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Guests A ${run}`, slug: `guests-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Guests B ${run}`, slug: `guests-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!orgA || !orgB) throw new Error("org insert returned no row");
  orgAId = orgA.id;
  orgBId = orgB.id;

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
  ]);
});

afterAll(async () => {
  if (userAId) await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
  if (userBId) await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
  if (orgAId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  if (orgBId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await pool.end();
});

describe("guests — upsert behaviour", () => {
  const email = `jane-${run}@example.com`;

  it("creates a guest and encrypts the PII columns", async () => {
    const r = await upsertGuest(orgAId, userAId, {
      firstName: "Jane",
      lastName: "Doe",
      email,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(false);

    const [row] = await db.select().from(schema.guests).where(eq(schema.guests.id, r.guestId));
    expect(row).toBeDefined();
    if (!row) return;

    // Plaintext first name is fine per gdpr.md.
    expect(row.firstName).toBe("Jane");
    // Ciphers should not equal the plaintext.
    expect(row.lastNameCipher).not.toBe("Doe");
    expect(row.emailCipher).not.toBe(email);
    // Hash is deterministic and matches the normalised email.
    expect(row.emailHash).toBe(hashForLookup(email, "email"));
    // Decrypt round-trip proves it's the right org's DEK.
    expect(await decryptPii(orgAId, row.emailCipher as Ciphertext)).toBe(email);
    expect(await decryptPii(orgAId, row.lastNameCipher as Ciphertext)).toBe("Doe");
  });

  it("silently reuses the row on duplicate email + adds phone on second call", async () => {
    const r = await upsertGuest(orgAId, userAId, {
      firstName: "Jane",
      lastName: "Doe",
      email,
      phone: "+44 7700 900123",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(true);

    const [row] = await db.select().from(schema.guests).where(eq(schema.guests.id, r.guestId));
    if (!row) return;
    expect(row.phoneCipher).not.toBeNull();
    expect(await decryptPii(orgAId, row.phoneCipher as Ciphertext)).toBe("+44 7700 900123");
  });

  it("refreshes first name on reuse", async () => {
    const r = await upsertGuest(orgAId, userAId, {
      firstName: "Janet", // changed from Jane
      email,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(true);

    const [row] = await db
      .select({ firstName: schema.guests.firstName })
      .from(schema.guests)
      .where(eq(schema.guests.id, r.guestId));
    expect(row?.firstName).toBe("Janet");
  });

  it("same email in a different org creates a separate row", async () => {
    const rA = await upsertGuest(orgAId, userAId, { firstName: "Jane", email });
    const rB = await upsertGuest(orgBId, userBId, { firstName: "Jane", email });
    expect(rA.ok && rB.ok).toBe(true);
    if (!rA.ok || !rB.ok) return;
    expect(rA.guestId).not.toBe(rB.guestId);
  });

  it("rejects invalid input with a typed error", async () => {
    const r = await upsertGuest(orgAId, userAId, {
      firstName: "",
      email: "not-an-email",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid-input");
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("guests — cross-tenant RLS", () => {
  it("user A cannot see org B's guests", async () => {
    await upsertGuest(orgBId, userBId, {
      firstName: "Orgb",
      email: `org-b-only-${run}@example.com`,
    });
    const rows = await asUser(userAId, (tx) => tx.select().from(schema.guests));
    const orgIds = new Set(rows.map((r) => r.organisationId));
    expect(orgIds).not.toContain(orgBId);
  });

  it("authenticated role cannot insert directly (no INSERT policy)", async () => {
    await expect(
      asUser(userAId, (tx) =>
        tx.insert(schema.guests).values({
          organisationId: orgAId,
          firstName: "Hacker",
          lastNameCipher: "x",
          emailCipher: "x",
          emailHash: "x",
        }),
      ),
    ).rejects.toThrow();
  });
});
