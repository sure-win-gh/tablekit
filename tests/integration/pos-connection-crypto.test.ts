// Integration test for lib/pos/connection.ts — proves OAuth tokens and the
// webhook secret round-trip through encryptPii/decryptPii and that NO
// plaintext secret is ever written to the stored cipher columns.
//
// Acceptance criterion (docs/specs/pos-integrations.md): "OAuth tokens +
// webhook secrets are stored via encryptPii and round-trip through
// decryptPii; no token ever written or logged in plaintext."

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { loadPosConnectionSecrets, upsertPosConnection } from "@/lib/pos/connection";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);

const ACCESS = `sq-access-${run}-SECRET`;
const REFRESH = `sq-refresh-${run}-SECRET`;
const WEBHOOK = `whsec-${run}-SECRET`;

type Ctx = { orgId: string; venueId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-Crypto ${run}`, slug: `pos-crypto-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");
  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: org.id, name: "V", venueType: "restaurant" })
    .returning({ id: schema.venues.id });
  if (!venue) throw new Error("venue insert returned no row");
  ctx = { orgId: org.id, venueId: venue.id };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("upsertPosConnection — secret round-trip", () => {
  it("stores ciphertext, never plaintext, and decrypts back to the originals", async () => {
    const connId = await upsertPosConnection({
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      provider: "square",
      externalAccountId: "loc_123",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      webhookSecret: WEBHOOK,
      tokenExpiresAt: new Date("2026-12-31T00:00:00Z"),
    });

    // Raw columns must hold ciphertext, not the plaintext secret.
    const [raw] = await db
      .select({
        access: schema.posConnections.accessTokenCipher,
        refresh: schema.posConnections.refreshTokenCipher,
        webhook: schema.posConnections.webhookSecretCipher,
        orgId: schema.posConnections.organisationId,
      })
      .from(schema.posConnections)
      .where(eq(schema.posConnections.id, connId));

    expect(raw?.orgId).toBe(ctx.orgId);
    expect(raw?.access).not.toBe(ACCESS);
    expect(raw?.access).toMatch(/^v1:/);
    expect(raw?.access).not.toContain("SECRET");
    expect(raw?.refresh).not.toContain("SECRET");
    expect(raw?.webhook).not.toContain("SECRET");

    // And decrypt back to the originals.
    const secrets = await loadPosConnectionSecrets(connId);
    expect(secrets).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, webhookSecret: WEBHOOK });
  });

  it("re-connecting overwrites supplied secrets and preserves the row id", async () => {
    const first = await upsertPosConnection({
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      provider: "square",
      accessToken: ACCESS,
    });
    const NEW_ACCESS = `sq-access-rotated-${run}-SECRET`;
    const second = await upsertPosConnection({
      organisationId: ctx.orgId,
      venueId: ctx.venueId,
      provider: "square",
      accessToken: NEW_ACCESS,
    });
    expect(second).toBe(first); // same (venue, provider) → same row
    const secrets = await loadPosConnectionSecrets(second);
    expect(secrets?.accessToken).toBe(NEW_ACCESS);
    // The webhook secret set on the first test is preserved (not supplied here).
    expect(secrets?.webhookSecret).toBe(WEBHOOK);
  });

  it("returns null for an unknown connection id", async () => {
    const secrets = await loadPosConnectionSecrets("00000000-0000-0000-0000-000000000000");
    expect(secrets).toBeNull();
  });
});
