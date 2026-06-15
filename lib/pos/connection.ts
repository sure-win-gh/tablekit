// POS connection store — create/upsert a pos_connections row with the
// OAuth grant + webhook secret envelope-encrypted, and read them back
// decrypted for use by the ingest/backfill paths.
//
// Cipher columns (access_token, refresh_token, webhook_secret) are
// credentials: encrypted via lib/security/crypto.encryptPii under the
// org DEK, exactly like venue_oauth_connections. NEVER logged, never
// surfaced in an error message. All writes go through adminDb() (the
// table has no authenticated write policy — see migration 0049).

import "server-only";

import { eq } from "drizzle-orm";

import { posConnections } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { decryptPii, encryptPii, type Ciphertext } from "@/lib/security/crypto";

export type PosProvider = "square" | "lightspeed_k" | "generic";

export type UpsertPosConnectionParams = {
  organisationId: string;
  venueId: string;
  provider: PosProvider;
  externalAccountId?: string | null;
  // Plaintext secrets — encrypted here before they touch the DB. Omit a
  // field to leave the stored cipher untouched on re-connect.
  accessToken?: string | null;
  refreshToken?: string | null;
  webhookSecret?: string | null;
  tokenExpiresAt?: Date | null;
  createdByUserId?: string | null;
};

export type PosConnectionSecrets = {
  accessToken: string | null;
  refreshToken: string | null;
  webhookSecret: string | null;
};

// Upsert on (venue_id, provider). Re-connecting overwrites the supplied
// secrets but preserves the row id. Returns the connection id.
export async function upsertPosConnection(params: UpsertPosConnectionParams): Promise<string> {
  const { organisationId, venueId, provider } = params;
  const db = adminDb();

  // Encrypt only the secrets that were actually supplied. encryptPii needs
  // the real org id to load the DEK; the stored organisation_id column is
  // (re)derived from the parent venue by the enforce trigger regardless.
  const accessTokenCipher =
    params.accessToken != null ? await encryptPii(organisationId, params.accessToken) : undefined;
  const refreshTokenCipher =
    params.refreshToken != null ? await encryptPii(organisationId, params.refreshToken) : undefined;
  const webhookSecretCipher =
    params.webhookSecret != null
      ? await encryptPii(organisationId, params.webhookSecret)
      : undefined;

  // Fields that, when provided, should overwrite on conflict.
  const mutable: Record<string, unknown> = { updatedAt: new Date() };
  if (params.externalAccountId !== undefined)
    mutable["externalAccountId"] = params.externalAccountId;
  if (accessTokenCipher !== undefined) mutable["accessTokenCipher"] = accessTokenCipher;
  if (refreshTokenCipher !== undefined) mutable["refreshTokenCipher"] = refreshTokenCipher;
  if (webhookSecretCipher !== undefined) mutable["webhookSecretCipher"] = webhookSecretCipher;
  if (params.tokenExpiresAt !== undefined) mutable["tokenExpiresAt"] = params.tokenExpiresAt;

  const [row] = await db
    .insert(posConnections)
    .values({
      organisationId, // (re)derived by the enforce trigger from the venue
      venueId,
      provider,
      externalAccountId: params.externalAccountId ?? null,
      accessTokenCipher: accessTokenCipher ?? null,
      refreshTokenCipher: refreshTokenCipher ?? null,
      webhookSecretCipher: webhookSecretCipher ?? null,
      tokenExpiresAt: params.tokenExpiresAt ?? null,
      createdByUserId: params.createdByUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [posConnections.venueId, posConnections.provider],
      set: mutable,
    })
    .returning({ id: posConnections.id });

  if (!row) throw new Error("lib/pos/connection.ts: upsert returned no row");
  return row.id;
}

// Read + decrypt the stored secrets for a connection. Returns null if the
// connection doesn't exist. The plaintext secrets must never be logged.
export async function loadPosConnectionSecrets(
  connectionId: string,
): Promise<PosConnectionSecrets | null> {
  const db = adminDb();
  const [row] = await db
    .select({
      organisationId: posConnections.organisationId,
      accessTokenCipher: posConnections.accessTokenCipher,
      refreshTokenCipher: posConnections.refreshTokenCipher,
      webhookSecretCipher: posConnections.webhookSecretCipher,
    })
    .from(posConnections)
    .where(eq(posConnections.id, connectionId))
    .limit(1);

  if (!row) return null;

  const decrypt = (c: string | null): Promise<string> | null =>
    c != null ? decryptPii(row.organisationId, c as Ciphertext) : null;

  return {
    accessToken: (await decrypt(row.accessTokenCipher)) ?? null,
    refreshToken: (await decrypt(row.refreshTokenCipher)) ?? null,
    webhookSecret: (await decrypt(row.webhookSecretCipher)) ?? null,
  };
}
