// Pure crypto helpers for outreach claim tokens.
//
// Same posture as lib/auth/invitations.ts: 32 random bytes encoded
// base64url, SHA-256 hashed before storage. Plaintext lives only in
// the URL emailed to the prospect and the minter's memory for ~1ms.
//
// These functions intentionally have no DB dependency — the
// transactional insert happens in lib/outreach/create-claimable.ts
// where token mint + organisation creation must commit together.

import "server-only";

import { createHash, randomBytes } from "node:crypto";

// 30 days. Matches the unclaimed-org purge window in PR 6's cron —
// past that point the org is gone and the link 404s anyway.
export const CLAIM_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type GeneratedToken = {
  // Plaintext — embed in the URL, then forget it.
  token: string;
  // SHA-256 hex digest — what lands in outreach_claims.token_hash.
  tokenHash: string;
};

export function generateClaimToken(): GeneratedToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashClaimToken(token) };
}

// Exported so the resolve path (PR 5) can hash the URL-supplied
// plaintext and look up by hash — never compares plaintext.
//
// PR 5 note: query by `WHERE token_hash = $1` (constant-time at the
// index level, no Postgres-side string comparison on the plaintext)
// rather than fetching all rows and comparing in app code.
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Convenience: when a prospect's email contains the link, the URL
// shape is fixed by the /claim/[token] route. Build it here so the
// admin UI + email template share one source of truth.
export function buildClaimUrl(input: { token: string; appUrl: string }): string {
  const base = input.appUrl.replace(/\/$/, "");
  return `${base}/claim/${encodeURIComponent(input.token)}`;
}
