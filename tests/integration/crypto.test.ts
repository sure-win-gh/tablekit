// Integration tests for envelope encryption.
//
// The unit tests in tests/unit/crypto.test.ts cover the pure bits
// (hashForLookup, master-key loader). The round-trip below needs a
// real organisation row so the lazy DEK provisioning path (read row,
// generate DEK, wrap with master, persist, cache) actually runs.
//
// Asserts the four guarantees the crypto phase makes:
//   1. encrypt → decrypt round-trips to the original plaintext
//   2. ciphertexts are non-deterministic (different IV every call)
//   3. tampering trips GCM auth-tag detection
//   4. ciphertext from org A cannot be decrypted as org B (wrong DEK)

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  _resetMasterKeyForTests,
  decryptPii,
  encryptPii,
  type Ciphertext,
} from "@/lib/security/crypto";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);
let orgAId: string;
let orgBId: string;

beforeAll(async () => {
  // Make sure the master key from .env.local is freshly loaded after
  // any previous test file fiddled with it.
  _resetMasterKeyForTests();

  const [a] = await db
    .insert(schema.organisations)
    .values({ name: `Crypto A ${run}`, slug: `crypto-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [b] = await db
    .insert(schema.organisations)
    .values({ name: `Crypto B ${run}`, slug: `crypto-b-${run}` })
    .returning({ id: schema.organisations.id });
  if (!a || !b) throw new Error("org insert returned no row");
  orgAId = a.id;
  orgBId = b.id;
});

afterAll(async () => {
  if (orgAId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  if (orgBId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await pool.end();
});

describe("crypto — envelope encryption", () => {
  it("round-trips a plaintext through encrypt → decrypt", async () => {
    const ct = await encryptPii(orgAId, "Smith");
    expect(ct).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    const pt = await decryptPii(orgAId, ct);
    expect(pt).toBe("Smith");
  });

  it("provisions a wrapped DEK lazily on first use", async () => {
    // The second org has never been encrypted for; calling encryptPii
    // should populate wrapped_dek.
    const [before] = await db
      .select({ wrappedDek: schema.organisations.wrappedDek })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, orgBId));
    expect(before?.wrappedDek).toBeNull();

    await encryptPii(orgBId, "anything");

    const [after] = await db
      .select({ wrappedDek: schema.organisations.wrappedDek })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, orgBId));
    // 60 bytes: 12 IV + 16 tag + 32 DEK
    expect(after?.wrappedDek?.length).toBe(60);
  });

  it("produces a different ciphertext every call (random IV)", async () => {
    const ct1 = await encryptPii(orgAId, "same-plaintext");
    const ct2 = await encryptPii(orgAId, "same-plaintext");
    expect(ct1).not.toBe(ct2);
    // But both round-trip to the same value.
    expect(await decryptPii(orgAId, ct1)).toBe("same-plaintext");
    expect(await decryptPii(orgAId, ct2)).toBe("same-plaintext");
  });

  it("detects tampering via the GCM auth tag", async () => {
    const ct = await encryptPii(orgAId, "confidential");
    // Flip one character in the ciphertext segment (middle section).
    const parts = ct.split(":");
    const ctB64 = parts[2]!;
    const flipped = ctB64[0] === "A" ? "B" + ctB64.slice(1) : "A" + ctB64.slice(1);
    const tampered = `${parts[0]}:${parts[1]}:${flipped}:${parts[3]}` as Ciphertext;
    await expect(decryptPii(orgAId, tampered)).rejects.toThrow();
  });

  it("rejects a ciphertext decrypted against the wrong org", async () => {
    const ctA = await encryptPii(orgAId, "org-A-secret");
    await expect(decryptPii(orgBId, ctA)).rejects.toThrow();
  });

  it("rejects ciphertexts in an unknown version", async () => {
    const ct = await encryptPii(orgAId, "x");
    const bumped = ct.replace(/^v1:/, "v9:") as Ciphertext;
    await expect(decryptPii(orgAId, bumped)).rejects.toThrow(/version v9 not supported/);
  });

  it("rejects malformed ciphertexts", async () => {
    await expect(decryptPii(orgAId, "not-a-ciphertext" as Ciphertext)).rejects.toThrow(
      /not in the expected/,
    );
  });
});
