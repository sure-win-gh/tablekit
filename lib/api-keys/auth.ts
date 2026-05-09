// Resolve an `Authorization: Bearer sk_live_...` header to an
// organisation id. Used by the public REST API route handlers
// (PR2 of the public-api series).
//
// Lookup is a single SQL query against the unique hash index. Returns
// null on any failure (header missing, malformed, unknown key,
// revoked) — the caller decides whether to 401 or 403, but should
// always return an opaque message so a probing attacker can't
// distinguish "key doesn't exist" from "key was revoked yesterday".
//
// Side effect: bumps `last_used_at` best-effort, debounced to ≥1h
// since the previous bump. The debounce keeps an active key from
// becoming a hot row under sustained traffic.

import "server-only";

import { and, eq, isNull, lt, or } from "drizzle-orm";

import { apiKeys } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { KEY_PREFIX, sha256Hex } from "./issue";

// 1 hour — bump last_used_at no more often than this per key.
const LAST_USED_DEBOUNCE_MS = 60 * 60 * 1000;

export type ResolvedKey = {
  id: string;
  organisationId: string;
};

// Parse the header, hash, look up. Null on any failure.
export async function resolveBearerToken(
  authorizationHeader: string | null,
): Promise<ResolvedKey | null> {
  const token = parseBearer(authorizationHeader);
  if (!token) return null;

  const hash = sha256Hex(token);
  const db = adminDb();
  const [row] = await db
    .select({
      id: apiKeys.id,
      organisationId: apiKeys.organisationId,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;

  // Best-effort last_used_at bump. Conditional UPDATE so concurrent
  // requests don't all stomp the row — only one wins per debounce
  // window. Errors here don't fail the auth — fire-and-forget.
  void touchLastUsed(row.id).catch(() => undefined);

  return row;
}

// Conditional UPDATE: only bumps if last_used_at is null OR older
// than the debounce window. Saves write traffic on hot keys.
async function touchLastUsed(keyId: string): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - LAST_USED_DEBOUNCE_MS);
  const db = adminDb();
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(
      and(eq(apiKeys.id, keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff))),
    );
}

// Strict header parser. Tolerates `Bearer ` prefix (case-insensitive),
// rejects anything else. Returns null on any deviation so the lookup
// path stays uniform — caller treats null as "auth failed".
function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Case-insensitive `Bearer ` per RFC 6750.
  if (!/^bearer\s+/i.test(trimmed)) return null;
  const token = trimmed.replace(/^bearer\s+/i, "").trim();
  if (!token.startsWith(KEY_PREFIX)) return null;
  // Reject anything obviously malformed before hashing — saves a
  // pointless DB round-trip on garbage input. Real keys are exactly
  // 40 chars (`sk_live_` + 32 base64url chars).
  if (token.length !== 40) return null;
  return token;
}
