// Issue + revoke API keys.
//
// Plaintext flow:
//   1. Generate 24 cryptographically-random bytes (192 bits entropy).
//   2. Encode as base64url (32 chars, no padding).
//   3. Plaintext key = `sk_live_${encoded}`.
//   4. Display once to the operator (action layer's responsibility).
//   5. Persist SHA-256(plaintext) as the lookup column. Plaintext
//      is then dropped from memory — the operator has it, we never
//      see it again.
//
// The issuer caller is the dashboard server action; it's already
// gated by requireRole("owner") + requirePlan(orgId, "plus") +
// active-org cookie. This module assumes the caller has authorised
// the action and just runs the DB write.

import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { apiKeys } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

export const KEY_PREFIX = "sk_live_";
const SECRET_BYTES = 24; // 192 bits of entropy

export type IssuedKey = {
  // The full plaintext token to show the operator exactly once.
  // NEVER store this anywhere downstream — the dashboard renders it
  // and instructs the operator to copy it before navigating away.
  plaintext: string;
  // The persisted row's id, for audit logging by the caller.
  id: string;
  // The displayable prefix (`sk_live_xxxx`).
  prefix: string;
};

export async function issueApiKey(args: {
  organisationId: string;
  label: string;
  createdByUserId: string;
}): Promise<IssuedKey> {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${KEY_PREFIX}${secret}`;
  const prefix = plaintext.slice(0, 12); // "sk_live_" + first 4 chars
  const hash = sha256Hex(plaintext);

  const db = adminDb();
  const [row] = await db
    .insert(apiKeys)
    .values({
      organisationId: args.organisationId,
      prefix,
      hash,
      label: args.label,
      createdByUserId: args.createdByUserId,
    })
    .returning({ id: apiKeys.id });
  if (!row) {
    throw new Error("lib/api-keys/issue.ts: insert returned no row");
  }

  return { plaintext, id: row.id, prefix };
}

// Set revoked_at = now() if not already revoked. Idempotent: a second
// call against an already-revoked key is a no-op (rowsAffected = 0).
export async function revokeApiKey(args: {
  keyId: string;
  organisationId: string;
}): Promise<{ revoked: boolean }> {
  const db = adminDb();
  const updated = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, args.keyId),
        eq(apiKeys.organisationId, args.organisationId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  return { revoked: updated.length > 0 };
}

// SHA-256 of the plaintext key, hex-encoded. Exported for tests +
// for the auth lookup module (lib/api-keys/auth.ts) so both sides
// hash the same way.
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
