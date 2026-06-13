// Yields a usable OAuth access token for a POS connection, refreshing the
// stored one if it's expired (or about to). Encapsulates the cipher round-trip
// + the refresh-token rotation + persistence so callers (Square order fetch,
// backfill) never touch ciphertext or worry about expiry. Mirrors
// lib/google/connection.ts:getActiveGoogleConnection.
//
// On an unrecoverable token (expired with no refresh token, or a refresh
// failure) the connection is marked status='error' with a non-PII last_error
// and null is returned — the operator must reconnect. The generic provider has
// no OAuth (it authenticates each webhook with a per-connection secret), so it
// has no access token and returns null here.

import "server-only";

import { eq } from "drizzle-orm";

import { posConnections } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { decryptPii, encryptPii, type Ciphertext } from "@/lib/security/crypto";

import type { PosProvider } from "./connection";
import { refreshLightspeedToken } from "./lightspeed/oauth";
import { refreshSquareToken } from "./square/oauth";

const REFRESH_SKEW_S = 60; // refresh if the token expires within the next minute

export type RefreshedTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
};

export type Refresher = (refreshToken: string) => Promise<RefreshedTokens>;

// Default per-provider refreshers. Injectable so tests don't hit the network.
export const DEFAULT_REFRESHERS: Record<PosProvider, Refresher | null> = {
  square: (rt) => refreshSquareToken(rt),
  lightspeed_k: (rt) => refreshLightspeedToken(rt),
  generic: null, // no OAuth — webhook-secret auth only
};

export async function getActivePosAccessToken(
  connectionId: string,
  opts?: { refreshers?: Record<PosProvider, Refresher | null>; now?: Date },
): Promise<string | null> {
  const refreshers = opts?.refreshers ?? DEFAULT_REFRESHERS;
  const now = opts?.now ?? new Date();
  const db = adminDb();

  const [row] = await db
    .select({
      id: posConnections.id,
      organisationId: posConnections.organisationId,
      provider: posConnections.provider,
      status: posConnections.status,
      accessTokenCipher: posConnections.accessTokenCipher,
      refreshTokenCipher: posConnections.refreshTokenCipher,
      tokenExpiresAt: posConnections.tokenExpiresAt,
    })
    .from(posConnections)
    .where(eq(posConnections.id, connectionId))
    .limit(1);

  if (!row || row.status === "revoked" || !row.accessTokenCipher) return null;

  // No known expiry → treat the stored token as valid (don't refresh blindly).
  const expiresAtMs = row.tokenExpiresAt?.getTime() ?? Infinity;
  const stale = expiresAtMs - now.getTime() < REFRESH_SKEW_S * 1000;

  if (!stale) {
    return decryptPii(row.organisationId, row.accessTokenCipher as Ciphertext);
  }

  const refresher = refreshers[row.provider];
  if (!refresher || !row.refreshTokenCipher) {
    await markErrored(row.id, "token expired; reconnect required");
    return null;
  }

  let fresh: RefreshedTokens;
  try {
    const refreshTokenPlain = await decryptPii(
      row.organisationId,
      row.refreshTokenCipher as Ciphertext,
    );
    fresh = await refresher(refreshTokenPlain);
  } catch {
    // Never echo the provider error (could carry token fragments).
    await markErrored(row.id, "token refresh failed");
    return null;
  }

  // Persist the rotated tokens (Square rotates the refresh token on use).
  const accessCipher = await encryptPii(row.organisationId, fresh.accessToken);
  const refreshCipher = fresh.refreshToken
    ? await encryptPii(row.organisationId, fresh.refreshToken)
    : row.refreshTokenCipher;
  await db
    .update(posConnections)
    .set({
      accessTokenCipher: accessCipher,
      refreshTokenCipher: refreshCipher,
      tokenExpiresAt: fresh.expiresAt,
      status: "active",
      lastError: null,
      updatedAt: now,
    })
    .where(eq(posConnections.id, row.id));

  return fresh.accessToken;
}

async function markErrored(connectionId: string, reason: string): Promise<void> {
  await adminDb()
    .update(posConnections)
    .set({ status: "error", lastError: reason, updatedAt: new Date() })
    .where(eq(posConnections.id, connectionId));
}
