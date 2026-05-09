// Integration tests for the Idempotency-Key helper.
// Exercises the two-phase claim against a real DB so we catch SQL
// behaviour the unit layer would mock away.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { issueApiKey } from "@/lib/api-keys/issue";
import { withIdempotency } from "@/lib/api/v1/idempotency";
import * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
type Ctx = { orgId: string; keyId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Idem ${run}`, slug: `idem-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const issued = await issueApiKey({
    organisationId: org!.id,
    label: "test",
    createdByUserId: null as unknown as string,
  });
  ctx = { orgId: org!.id, keyId: issued.id };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

describe("withIdempotency — first call", () => {
  it("runs the handler and returns kind: ran", async () => {
    let invocations = 0;
    const out = await withIdempotency({ apiKeyId: ctx.keyId, key: `k-ran-${run}` }, async () => {
      invocations++;
      return { status: 201, body: { data: { id: "fresh" } } };
    });
    expect(out.kind).toBe("ran");
    expect(invocations).toBe(1);
    if (out.kind === "ran") {
      expect(out.response.status).toBe(201);
      expect(out.response.body).toEqual({ data: { id: "fresh" } });
    }
  });
});

describe("withIdempotency — replay", () => {
  it("returns the cached response without re-running the handler", async () => {
    const key = `k-replay-${run}`;
    let invocations = 0;
    const handler = async () => {
      invocations++;
      return { status: 200, body: { data: { id: invocations } } };
    };

    const first = await withIdempotency({ apiKeyId: ctx.keyId, key }, handler);
    expect(first.kind).toBe("ran");

    const second = await withIdempotency({ apiKeyId: ctx.keyId, key }, handler);
    expect(second.kind).toBe("cached");
    if (second.kind === "cached") {
      expect(second.response.body).toEqual({ data: { id: 1 } });
    }
    expect(invocations).toBe(1);
  });
});

describe("withIdempotency — failure path", () => {
  it("drops the claim row when the handler throws so a retry can re-attempt", async () => {
    const key = `k-throw-${run}`;
    await expect(
      withIdempotency({ apiKeyId: ctx.keyId, key }, async () => {
        throw new Error("simulated");
      }),
    ).rejects.toThrow("simulated");

    // The retry should re-claim cleanly (kind: ran), not see a stale
    // null-status row that would lock the key forever.
    let invocations = 0;
    const retry = await withIdempotency({ apiKeyId: ctx.keyId, key }, async () => {
      invocations++;
      return { status: 201, body: { data: { id: "after-retry" } } };
    });
    expect(retry.kind).toBe("ran");
    expect(invocations).toBe(1);
  });
});

describe("withIdempotency — bucketing per api_key_id", () => {
  it("two keys can share an Idempotency-Key value without colliding", async () => {
    const [orgB] = await db
      .insert(schema.organisations)
      .values({ name: `Idem-B ${run}`, slug: `idem-b-${run}`, plan: "plus" })
      .returning({ id: schema.organisations.id });
    const issuedB = await issueApiKey({
      organisationId: orgB!.id,
      label: "test-b",
      createdByUserId: null as unknown as string,
    });
    try {
      const sharedKey = `k-shared-${run}`;
      const a = await withIdempotency({ apiKeyId: ctx.keyId, key: sharedKey }, async () => ({
        status: 200,
        body: { data: "from-A" },
      }));
      const b = await withIdempotency({ apiKeyId: issuedB.id, key: sharedKey }, async () => ({
        status: 200,
        body: { data: "from-B" },
      }));
      expect(a.kind).toBe("ran");
      expect(b.kind).toBe("ran"); // not "cached" — different bucket
    } finally {
      await db.delete(schema.organisations).where(eq(schema.organisations.id, orgB!.id));
    }
  });
});
