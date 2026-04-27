// Loads a venue's Google OAuth connection and yields a usable access
// token, refreshing if the stored one has expired. Encapsulates the
// cipher → plaintext round-trip so callers (sync job, future reply
// API path) don't touch ciphertext directly.

import "server-only";

import { and, eq } from "drizzle-orm";

import { venueOauthConnections } from "@/lib/db/schema";
import { refreshAccessToken } from "@/lib/oauth/google";
import { adminDb } from "@/lib/server/admin/db";
import { decryptPii, encryptPii, type Ciphertext } from "@/lib/security/crypto";

export type ActiveGoogleConnection = {
  venueId: string;
  organisationId: string;
  externalAccountId: string | null;
  accessToken: string;
  scopes: string;
};

const REFRESH_SKEW_S = 60; // refresh if token expires within the next minute

export async function getActiveGoogleConnection(
  venueId: string,
): Promise<ActiveGoogleConnection | null> {
  const db = adminDb();
  const [row] = await db
    .select()
    .from(venueOauthConnections)
    .where(
      and(
        eq(venueOauthConnections.venueId, venueId),
        eq(venueOauthConnections.provider, "google"),
      ),
    )
    .limit(1);
  if (!row) return null;

  const expiresAtMs = row.tokenExpiresAt?.getTime() ?? 0;
  const stale = expiresAtMs - Date.now() < REFRESH_SKEW_S * 1000;

  let accessToken: string;
  if (!stale) {
    accessToken = await decryptPii(row.organisationId, row.accessTokenCipher as Ciphertext);
  } else {
    if (!row.refreshTokenCipher) {
      // Token expired and there's no refresh token (Google sometimes
      // omits one on re-consent). Caller treats this as "not
      // connected" — the operator needs to reconnect.
      return null;
    }
    const refreshTokenPlain = await decryptPii(
      row.organisationId,
      row.refreshTokenCipher as Ciphertext,
    );
    const fresh = await refreshAccessToken({ refreshToken: refreshTokenPlain });
    accessToken = fresh.accessToken;
    const newCipher = await encryptPii(row.organisationId, fresh.accessToken);
    const newExpiry = new Date(Date.now() + fresh.expiresInSeconds * 1000);
    await db
      .update(venueOauthConnections)
      .set({ accessTokenCipher: newCipher, tokenExpiresAt: newExpiry })
      .where(eq(venueOauthConnections.id, row.id));
  }

  return {
    venueId: row.venueId,
    organisationId: row.organisationId,
    externalAccountId: row.externalAccountId,
    accessToken,
    scopes: row.scopes,
  };
}

export async function markVenueSynced(venueId: string): Promise<void> {
  await adminDb()
    .update(venueOauthConnections)
    .set({ lastSyncedAt: new Date() })
    .where(
      and(
        eq(venueOauthConnections.venueId, venueId),
        eq(venueOauthConnections.provider, "google"),
      ),
    );
}
