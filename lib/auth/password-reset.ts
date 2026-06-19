// Password-reset tokens: mint + resolve + consume.
//
// Mirrors lib/auth/invitations.ts. Tokens are 32 random bytes encoded
// base64url; we never persist the plaintext — only its SHA-256 hash lands
// in `password_reset_tokens.token_hash`. The plaintext lives in the emailed
// URL only. Single-use is enforced atomically in `consumeResetToken` (a
// conditional UPDATE), and there is at most one live token per user
// (minting deletes prior unused rows).
//
// Shared by both triggers: the self-serve flow (`/forgot-password`) and the
// support flow (an admin sets `initiatedByAdminId`). One token lifecycle.

import "server-only";

import { randomBytes, createHash } from "node:crypto";

import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

import { adminDb } from "@/lib/server/admin/db";
import { passwordResetTokens } from "@/lib/db/schema";

// 15-minute expiry per docs/specs/password-reset.md.
export const RESET_TTL_MS = 15 * 60 * 1000;

export type MintResetResult = {
  tokenId: string;
  // Plaintext token — return-once, never logged.
  token: string;
  expiresAt: Date;
};

// SHA-256 hex of the token. Pure — unit-testable without a DB.
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Build the reset URL the user follows. Pure. Mirrors buildClaimUrl.
export function buildResetUrl(input: { token: string; appUrl: string }): string {
  const base = input.appUrl.replace(/\/$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(input.token)}`;
}

/**
 * Mint a fresh reset token for a user. Invalidates any prior **unused**
 * token for that user first (one live token per user), then inserts the
 * new row. `initiatedByAdminId` marks a support-triggered reset (NULL for
 * self-serve). Returns the plaintext token once — never log it.
 */
export async function mintResetToken(
  userId: string,
  opts: { initiatedByAdminId?: string; ttlMs?: number } = {},
): Promise<MintResetResult> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? RESET_TTL_MS));

  const tokenId = await adminDb().transaction(async (tx) => {
    // Invalidate prior unused tokens so an old link can't outlive a new
    // request. Used rows are left for the retention sweep / audit trail.
    await tx
      .delete(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

    const [row] = await tx
      .insert(passwordResetTokens)
      .values({
        userId,
        tokenHash,
        expiresAt,
        ...(opts.initiatedByAdminId ? { initiatedByAdminId: opts.initiatedByAdminId } : {}),
      })
      .returning({ id: passwordResetTokens.id });

    if (!row) throw new Error("mintResetToken: insert returned no row");
    return row.id;
  });

  return { tokenId, token, expiresAt };
}

/**
 * Read-only resolve: is this token live (unused + unexpired)? Returns the
 * owning user id or null. Used by the reset page to show a valid/invalid
 * state before the user submits — does NOT consume the token.
 */
export async function resolveResetToken(token: string): Promise<{ userId: string } | null> {
  const tokenHash = hashResetToken(token);
  const [row] = await adminDb()
    .select({ userId: passwordResetTokens.userId })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return row ? { userId: row.userId } : null;
}

// 24h grace before a spent/expired token row is swept, leaving a short
// forensic window (e.g. to confirm an admin-initiated reset was used).
const RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete tokens that are used or expired and older than the 24h grace
 * window. Called by the daily cleanup cron. Returns the count removed.
 */
export async function sweepResetTokenRetention(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - RETENTION_GRACE_MS);
  const rows = await adminDb()
    .delete(passwordResetTokens)
    .where(or(lt(passwordResetTokens.usedAt, cutoff), lt(passwordResetTokens.expiresAt, cutoff)))
    .returning({ id: passwordResetTokens.id });
  return { deleted: rows.length };
}

/**
 * Atomically consume a token: mark it used iff it is still live, in a single
 * conditional UPDATE. Returns the owning user id, or null if the token is
 * unknown, expired, or already used. This is the single-use guarantee — two
 * concurrent submits can't both win because only one UPDATE matches the
 * `used_at IS NULL` predicate.
 */
export async function consumeResetToken(token: string): Promise<{ userId: string } | null> {
  const tokenHash = hashResetToken(token);
  const [row] = await adminDb()
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: passwordResetTokens.userId });

  return row ? { userId: row.userId } : null;
}
