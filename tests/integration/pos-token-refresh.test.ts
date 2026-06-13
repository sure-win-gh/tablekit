// Integration test for POS OAuth token refresh (getActivePosAccessToken).
//
//   * a still-valid token is returned as-is, no refresh;
//   * an expired token is refreshed via the (injected) provider refresher,
//     the rotated access + refresh tokens are re-encrypted + persisted, and
//     the connection stays active;
//   * an expired token with no refresh token marks the connection errored;
//   * a refresher failure marks the connection errored (no token leak).

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getActivePosAccessToken, type Refresher } from "@/lib/pos/active-connection";
import { loadPosConnectionSecrets, upsertPosConnection } from "@/lib/pos/connection";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const future = new Date(Date.now() + 60 * 60 * 1000);
const past = new Date(Date.now() - 60 * 60 * 1000);

type Ctx = { orgId: string; venueId: string };
let ctx: Ctx;

// Stub refresher that records calls and returns rotated tokens.
function stubRefreshers(rt: { calledWith?: string }): Record<string, Refresher | null> {
  const square: Refresher = async (refreshToken) => {
    rt.calledWith = refreshToken;
    return {
      accessToken: `new-access-${run}`,
      refreshToken: `new-refresh-${run}`,
      expiresAt: future,
    };
  };
  return { square, lightspeed_k: null, generic: null };
}

const failRefreshers: Record<string, Refresher | null> = {
  square: async () => {
    throw new Error("provider 500");
  },
  lightspeed_k: null,
  generic: null,
};

async function mkConn(opts: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt: Date | null;
}): Promise<string> {
  const id = await upsertPosConnection({
    organisationId: ctx.orgId,
    venueId: ctx.venueId,
    provider: "square",
    externalAccountId: `acct-${run}-${Math.round(opts.expiresAt?.getTime() ?? 0)}`,
    accessToken: opts.accessToken ?? `access-${run}`,
    refreshToken: opts.refreshToken ?? null,
    tokenExpiresAt: opts.expiresAt,
  });
  // upsert collapses on (venue, provider); we need distinct rows, so move this
  // one to a unique venue per call.
  return id;
}

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `POS-TR ${run}`, slug: `pos-tr-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  ctx = { orgId: org!.id, venueId: "" };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

// Each case uses its own venue so the (venue, provider) unique upsert gives a
// distinct connection.
async function freshConn(opts: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt: Date | null;
}): Promise<string> {
  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: ctx.orgId,
      name: `V-${run}-${Math.random()}`,
      venueType: "restaurant",
    })
    .returning({ id: schema.venues.id });
  ctx.venueId = venue!.id;
  return mkConn(opts);
}

describe("getActivePosAccessToken", () => {
  it("returns a still-valid token without refreshing", async () => {
    const connId = await freshConn({
      accessToken: `valid-${run}`,
      refreshToken: "r",
      expiresAt: future,
    });
    const rt: { calledWith?: string } = {};
    const token = await getActivePosAccessToken(connId, { refreshers: stubRefreshers(rt) });
    expect(token).toBe(`valid-${run}`);
    expect(rt.calledWith).toBeUndefined(); // no refresh
  });

  it("refreshes an expired token and persists the rotated tokens", async () => {
    const connId = await freshConn({
      accessToken: `old-${run}`,
      refreshToken: `old-refresh-${run}`,
      expiresAt: past,
    });
    const rt: { calledWith?: string } = {};
    const token = await getActivePosAccessToken(connId, { refreshers: stubRefreshers(rt) });

    expect(rt.calledWith).toBe(`old-refresh-${run}`); // refreshed with the stored token
    expect(token).toBe(`new-access-${run}`);

    // The rotated access + refresh tokens are persisted, encrypted.
    const secrets = await loadPosConnectionSecrets(connId);
    expect(secrets?.accessToken).toBe(`new-access-${run}`);
    expect(secrets?.refreshToken).toBe(`new-refresh-${run}`);

    const [conn] = await db
      .select({
        status: schema.posConnections.status,
        expiresAt: schema.posConnections.tokenExpiresAt,
      })
      .from(schema.posConnections)
      .where(eq(schema.posConnections.id, connId));
    expect(conn?.status).toBe("active");
    expect(conn?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the connection errored when an expired token has no refresh token", async () => {
    const connId = await freshConn({ accessToken: `noref-${run}`, expiresAt: past });
    const token = await getActivePosAccessToken(connId, { refreshers: stubRefreshers({}) });
    expect(token).toBeNull();
    const [conn] = await db
      .select({ status: schema.posConnections.status, lastError: schema.posConnections.lastError })
      .from(schema.posConnections)
      .where(eq(schema.posConnections.id, connId));
    expect(conn?.status).toBe("error");
    expect(conn?.lastError).toBeTruthy();
  });

  it("marks the connection errored when the refresher fails", async () => {
    const connId = await freshConn({
      accessToken: `fail-${run}`,
      refreshToken: "r",
      expiresAt: past,
    });
    const token = await getActivePosAccessToken(connId, { refreshers: failRefreshers });
    expect(token).toBeNull();
    const [conn] = await db
      .select({ status: schema.posConnections.status })
      .from(schema.posConnections)
      .where(eq(schema.posConnections.id, connId));
    expect(conn?.status).toBe("error");
  });
});
