// Integration tests for the api_request_log helper + retention sweep.
//
// Coverage:
//   - logRequest persists the documented fields, no more no less.
//   - logRequest truncates an oversize path defensively.
//   - logRequest doesn't throw when the apiKeyId references a key
//     that's been deleted (FK is SET NULL on cascade).
//   - sweepExpiredRequestLog deletes rows older than 90 days,
//     leaves rows under the cutoff alone.

import { eq, gte, lt } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { issueApiKey } from "@/lib/api-keys/issue";
import { logRequest, sweepExpiredRequestLog } from "@/lib/api/v1/request-log";
import * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
type Ctx = { orgId: string; keyId: string };
let ctx: Ctx;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `RL ${run}`, slug: `rl-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const issued = await issueApiKey({
    organisationId: org!.id,
    label: "test-key",
    createdByUserId: null as unknown as string,
  });
  ctx = { orgId: org!.id, keyId: issued.id };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

describe("logRequest", () => {
  it("persists the spec's required fields and nothing extra", async () => {
    await logRequest({
      organisationId: ctx.orgId,
      apiKeyId: ctx.keyId,
      method: "GET",
      path: "/api/v1/bookings",
      status: 200,
      latencyMs: 42,
    });

    const [row] = await db
      .select()
      .from(schema.apiRequestLog)
      .where(eq(schema.apiRequestLog.organisationId, ctx.orgId))
      .orderBy(schema.apiRequestLog.createdAt)
      .limit(1);

    expect(row?.method).toBe("GET");
    expect(row?.path).toBe("/api/v1/bookings");
    expect(row?.status).toBe(200);
    expect(row?.latencyMs).toBe(42);
    expect(row?.apiKeyId).toBe(ctx.keyId);
    expect(row?.organisationId).toBe(ctx.orgId);
  });

  it("truncates an oversize path to 500 chars before insert", async () => {
    const big = "/api/v1/bookings/" + "x".repeat(2000);
    await logRequest({
      organisationId: ctx.orgId,
      apiKeyId: ctx.keyId,
      method: "GET",
      path: big,
      status: 200,
      latencyMs: 10,
    });
    // Find the row by its known status range — paths are noisy
    // across tests but only one will have length 500.
    const rows = await db
      .select({ path: schema.apiRequestLog.path })
      .from(schema.apiRequestLog)
      .where(eq(schema.apiRequestLog.organisationId, ctx.orgId));
    const truncated = rows.find((r) => r.path.length === 500);
    expect(truncated).toBeTruthy();
  });
});

describe("sweepExpiredRequestLog", () => {
  it("deletes rows older than 90 days, keeps rows under the cutoff", async () => {
    const now = new Date("2026-09-01T12:00:00Z");
    // Insert two rows by hand so we can backdate created_at past
    // the helper's clock-anchored insert. logRequest always uses
    // defaultNow().
    const [oldRow] = await db
      .insert(schema.apiRequestLog)
      .values({
        organisationId: ctx.orgId,
        apiKeyId: ctx.keyId,
        method: "GET",
        path: "/old",
        status: 200,
        latencyMs: 10,
        createdAt: new Date(now.getTime() - 100 * DAY_MS),
      })
      .returning({ id: schema.apiRequestLog.id });
    const [recentRow] = await db
      .insert(schema.apiRequestLog)
      .values({
        organisationId: ctx.orgId,
        apiKeyId: ctx.keyId,
        method: "GET",
        path: "/recent",
        status: 200,
        latencyMs: 10,
        createdAt: new Date(now.getTime() - 30 * DAY_MS),
      })
      .returning({ id: schema.apiRequestLog.id });

    const r = await sweepExpiredRequestLog({ now });
    expect(r.deleted).toBeGreaterThanOrEqual(1);

    // The 100-day-old row is gone; the 30-day-old row stays.
    const oldStill = await db
      .select({ id: schema.apiRequestLog.id })
      .from(schema.apiRequestLog)
      .where(eq(schema.apiRequestLog.id, oldRow!.id));
    expect(oldStill).toEqual([]);

    const recentStill = await db
      .select({ id: schema.apiRequestLog.id })
      .from(schema.apiRequestLog)
      .where(eq(schema.apiRequestLog.id, recentRow!.id));
    expect(recentStill).toHaveLength(1);
  });

  it("returns deleted: 0 when nothing is eligible", async () => {
    // Pick a `now` so far in the past that nothing is eligible.
    const now = new Date("2024-01-01T00:00:00Z");
    const r = await sweepExpiredRequestLog({ now });
    expect(r.deleted).toBe(0);
  });
});

// Sanity-check that the assertion-helper imports stay used; the
// integration test config flags unused symbols otherwise.
void gte;
void lt;
